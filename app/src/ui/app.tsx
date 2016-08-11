import * as React from 'react'
import { ipcRenderer, remote } from 'electron'

import { Resizable } from './resizable'
import RepositoriesList from './repositories-list'
import { default as RepositoryView } from './repository'
import GitHubRepository from '../models/github-repository'
import NotLoggedIn from './not-logged-in'
import { WindowControls } from './window/window-controls'
import { Dispatcher, AppStore, GitUserStore } from '../lib/dispatcher'
import Repository from '../models/repository'
import { matchGitHubRepository } from '../lib/repository-matching'
import API, { getUserForEndpoint } from '../lib/api'
import { LocalGitOperations } from '../lib/local-git-operations'
import { MenuEvent } from '../main-process/menu'
import fatalError from '../lib/fatal-error'
import { IAppState, RepositorySection, Popup } from '../lib/app-state'
import Popuppy from './popuppy'
import CreateBranch from './create-branch'
import Branches from './branches'

interface IAppProps {
  readonly dispatcher: Dispatcher
  readonly appStore: AppStore
  readonly gitUserStore: GitUserStore
}

export default class App extends React.Component<IAppProps, IAppState> {
  public constructor(props: IAppProps) {
    super(props)

    this.state = props.appStore.getState()
    props.appStore.onDidUpdate(state => {
      state.users.forEach(user => {
        // In theory a user should _always_ have an array of emails (even if
        // it's empty). But in practice, if the user had run old dev builds this
        // may not be the case. So for now we need to guard this. We should
        // remove this check in the not too distant future.
        // @joshaber (August 10, 2016)
        if (!user.emails) { return }

        const gitUsers = user.emails.map(email => {
          return {
            endpoint: user.endpoint,
            email,
            login: user.login,
            avatarURL: user.avatarURL,
          }
        })

        for (const user of gitUsers) {
          this.props.gitUserStore.cacheUser(user)
        }
      })

      this.setState(state)
    })

    ipcRenderer.on('menu-event', (event: Electron.IpcRendererEvent, { name }: { name: MenuEvent }) => {
      this.onMenuEvent(name)
    })
  }

  private onMenuEvent(name: MenuEvent): any {
    switch (name) {
      case 'push': return this.push()
      case 'pull': return this.pull()
      case 'select-changes': return this.selectChanges()
      case 'select-history': return this.selectHistory()
      case 'add-local-repository': return this.showFileBrowser()
      case 'create-branch': return this.createBranch()
      case 'show-branches': return this.showBranches()
    }

    return fatalError(`Unknown menu event name: ${name}`)
  }

  private createBranch() {
    this.props.dispatcher.showPopup(Popup.CreateBranch, this.state.selectedRepository)
  }

  private showBranches() {
    this.props.dispatcher.showPopup(Popup.ShowBranches, this.state.selectedRepository)
  }

  private selectChanges(): Promise<void> {
    const repository = this.state.selectedRepository
    if (!repository) { return Promise.resolve() }

    return this.props.dispatcher.changeRepositorySection(repository, RepositorySection.Changes)
  }

  private selectHistory(): Promise<void> {
    const repository = this.state.selectedRepository
    if (!repository) { return Promise.resolve() }

    return this.props.dispatcher.changeRepositorySection(repository, RepositorySection.History)
  }

  private async push() {
    const repository = this.state.selectedRepository
    if (!repository) { return }

    const remote = await LocalGitOperations.getDefaultRemote(repository)
    if (!remote) {
      console.error('This repo has no remotes ¯\_(ツ)_/¯')
      return
    }

    const state = this.state.repositoryState
    if (!state) {
      console.error('¯\_(ツ)_/¯')
      return
    }

    const branch = state.currentBranch
    if (!branch) {
      console.error('This repo is on an unborn branch ¯\_(ツ)_/¯')
      return
    }

    const upstream = branch.upstream
    if (upstream) {
      await LocalGitOperations.push(repository, remote, branch.name, false)
    } else {
      await LocalGitOperations.push(repository, remote, branch.name, true)
    }
  }

  private async pull() {
    const repository = this.state.selectedRepository
    if (!repository) { return }

    const remote = await LocalGitOperations.getDefaultRemote(repository)
    if (!remote) {
      console.error('This repo has no remotes ¯\_(ツ)_/¯')
      return
    }

    const state = this.state.repositoryState
    if (!state) {
      console.error('¯\_(ツ)_/¯')
      return
    }

    const branch = state.currentBranch
    if (!branch) {
      console.error('This repo is on an unborn branch ¯\_(ツ)_/¯')
      return
    }

    await LocalGitOperations.pull(repository, remote, branch.name)
  }

  public componentDidMount() {
    document.ondragover = document.ondrop = (e) => {
      e.preventDefault()
    }

    document.body.ondrop = (e) => {
      const files = e.dataTransfer.files
      this.handleDragAndDrop(files)
      e.preventDefault()
    }
  }

  private handleDragAndDrop(fileList: FileList) {
    const paths: string[] = []
    for (let i = 0; i < fileList.length; i++) {
      const path = fileList[i]
      paths.push(path.path)
    }

    this.addRepositories(paths)
  }

  private showFileBrowser() {
    const directories = remote.dialog.
        showOpenDialog({ properties: [ 'openDirectory', 'multiSelections' ] })
    if (directories && directories.length > 0) {
      this.addRepositories(directories)
    }
  }

  private async addRepositories(paths: string[]) {
    const repositories = paths.map(p => new Repository(p))
    const addedRepos = await this.props.dispatcher.addRepositories(repositories)

    addedRepos.forEach(repo => this.refreshGitHubRepositoryInfo(repo))
  }

  private renderTitlebar() {
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      return null
    }

    const winControls = process.platform === 'win32'
      ? <WindowControls />
      : null

    return (
      <div id='desktop-app-title-bar'>
        <span className='app-title'>GitHub Desktop</span>
        {winControls}
      </div>
    )
  }

  /** Put the main application menu into a context menu for now (win only) */
  private onContextMenu(e: React.MouseEvent<any>) {
    if (process.platform === 'win32') {
      e.preventDefault()
      ipcRenderer.send('show-popup-app-menu', null)
    }
  }

  private renderPopup(): JSX.Element | null {
    const popup = this.state.currentPopup
    if (!popup) { return null }

    let content: JSX.Element | null = null
    switch (popup) {
      case Popup.CreateBranch:
        content = <CreateBranch repository={this.state.selectedRepository!}
                                dispatcher={this.props.dispatcher}
                                branches={this.state.repositoryState!.branches}
                                currentBranch={this.state.repositoryState!.currentBranch}/>
        break

      case Popup.ShowBranches:
        content = <Branches branches={this.state.repositoryState!.branches}
                            dispatcher={this.props.dispatcher}
                            repository={this.state.selectedRepository!}/>
        break
    }

    if (!content) {
      return fatalError(`Unknown popup: ${popup}`)
    }

    return <Popuppy>{content}</Popuppy>
  }

  private renderApp() {
    return (
      <div id='desktop-app-contents' onContextMenu={e => this.onContextMenu(e)}>
        <Resizable id='desktop-app-sidebar' configKey='repositories-list-width'>
          <RepositoriesList selectedRepository={this.state.selectedRepository}
                            onSelectionChanged={repository => this.onSelectionChanged(repository)}
                            repos={this.state.repositories}
                            // TODO: This is wrong. Just because we have 0 repos
                            // doesn't necessarily mean we're loading.
                            loading={this.state.repositories.length === 0}/>
        </Resizable>

        {this.renderRepository()}

        {this.renderPopup()}
      </div>
    )
  }

  private renderRepository() {
    const selectedRepository = this.state.selectedRepository
    if (!selectedRepository) {
      return <NoRepositorySelected/>
    }

    return (
      <RepositoryView repository={selectedRepository}
                      state={this.state.repositoryState!}
                      dispatcher={this.props.dispatcher}
                      gitUserStore={this.props.gitUserStore}/>
    )
  }

  private renderNotLoggedIn() {
    return (
      <div id='desktop-app-contents'>
        <NotLoggedIn dispatcher={this.props.dispatcher}/>
      </div>
    )
  }

  public render() {
    return (
      <div id='desktop-app-chrome'>
        {this.renderTitlebar()}
        {this.state.users.length > 0 ? this.renderApp() : this.renderNotLoggedIn()}
      </div>
    )
  }

  private refreshRepository(repository: Repository) {
    // This probably belongs in the Repository component or whatever, but until
    // that exists...
    console.log(repository)
    this.refreshGitHubRepositoryInfo(repository)
  }

  private onSelectionChanged(repository: Repository) {
    this.props.dispatcher.selectRepository(repository)

    this.refreshRepository(repository)
  }

  private async guessGitHubRepository(repository: Repository): Promise<GitHubRepository | null> {
    // TODO: This is all kinds of wrong. We shouldn't assume the remote is named
    // `origin`.
    const remote = await LocalGitOperations.getConfigValue(repository, 'remote.origin.url')
    if (!remote) { return null }

    return matchGitHubRepository(this.state.users, remote)
  }

  private async refreshGitHubRepositoryInfo(repository: Repository): Promise<void> {
    let gitHubRepository = repository.gitHubRepository
    if (!gitHubRepository) {
      gitHubRepository = await this.guessGitHubRepository(repository)
    }

    if (!gitHubRepository) { return Promise.resolve() }

    const users = this.state.users
    const user = getUserForEndpoint(users, gitHubRepository.endpoint)
    if (!user) { return Promise.resolve() }

    const api = new API(user)
    const apiRepo = await api.fetchRepository(gitHubRepository.owner.login, gitHubRepository.name)

    const updatedRepository = repository.withGitHubRepository(gitHubRepository.withAPI(apiRepo))
    this.props.dispatcher.updateGitHubRepository(updatedRepository)
  }
}

function NoRepositorySelected() {
  return (
    <div className='panel blankslate'>
      No repository selected
    </div>
  )
}

import type { Live, Overview, SessionDetail } from '../dashboard/contract.ts'
import { h } from './dom.ts'
import { liveView } from './live.ts'
import { findingsView, overviewView, projectsView, sessionView, sessionsView, type Links } from './read.ts'

function element(id: string): HTMLElement {
  const found = document.getElementById(id)
  if (!found) throw new Error(`index.html is missing #${id}`)
  return found
}

const main = element('main')
const nav = element('nav')
const filters = element('filters')
const context = element('context')
const help = element('help') as HTMLDialogElement

interface Route {
  path: string[]
  params: URLSearchParams
}

function route(): Route {
  const [path = '', query = ''] = location.hash.replace(/^#\/?/, '').split('?')
  return { path: path.split('/').filter(Boolean).map(decodeURIComponent), params: new URLSearchParams(query) }
}

function href(path: string, params: URLSearchParams): string {
  const query = params.toString()
  return `#/${path}${query ? `?${query}` : ''}`
}

const go = (target: string) => {
  location.hash = target
}

/** The server answered, but with an error. Distinct from fetch rejecting,
 *  which means the thermal process is gone. */
class Refused extends Error {}

async function getJSON<T>(url: string): Promise<T> {
  const response = await fetch(url)
  const body: unknown = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : `HTTP ${response.status}`
    throw new Refused(message)
  }
  return body as T
}

function fail(error: unknown): void {
  main.classList.remove('loading')
  const [headline, next] =
    error instanceof Refused
      ? [error.message, h('a', { class: 'secondary', href: '#/' }, 'Back to the overview')]
      : [
          `Thermal is not responding at ${location.origin}.`,
          h('span', { class: 'secondary' }, 'The dashboard reads from the thermal process that served this page. If it has stopped, start it again and reload.'),
        ]
  main.replaceChildren(
    h('section', { class: 'error' }, h('span', { class: 'glyph', 'aria-hidden': 'true' }, '▲'), h('b', {}, headline), h('p', {}, next)),
  )
}

const VIEWS = [
  { path: '', label: 'Overview' },
  { path: 'findings', label: 'Findings' },
  { path: 'sessions', label: 'Sessions' },
  { path: 'projects', label: 'Projects' },
]

const SINCE = [
  { days: '7', label: '7d' },
  { days: '30', label: '30d' },
  { days: '90', label: '90d' },
  { days: '', label: 'all' },
]

function scope(params: URLSearchParams): URLSearchParams {
  const kept = new URLSearchParams()
  for (const key of ['since', 'project']) {
    const value = params.get(key)
    if (value) kept.set(key, value)
  }
  return kept
}

function drawChrome(current: string, params: URLSearchParams, projects: string[]): void {
  const filter = scope(params)
  nav.replaceChildren(
    ...VIEWS.map((view) =>
      h('a', { href: href(view.path, filter), 'aria-current': view.path === current ? 'page' : undefined }, view.label),
    ),
  )

  const since = params.get('since') ?? ''
  const withParam = (key: string, value: string) => {
    const next = scope(params)
    if (value) next.set(key, value)
    else next.delete(key)
    return href(current, next)
  }

  const picker = h('select', { 'aria-label': 'Project' }, h('option', { value: '' }, 'all projects'), ...projects.map((name) => h('option', { value: name }, name)))
  picker.value = params.get('project') ?? ''
  picker.addEventListener('change', () => go(withParam('project', picker.value)))

  filters.className = 'filters'
  filters.replaceChildren(
    h('span', { class: 'label' }, 'Range'),
    h(
      'div',
      { class: 'segmented', role: 'group', 'aria-label': 'Time range' },
      ...SINCE.map((option) => {
        const button = h('button', { type: 'button', 'aria-pressed': String(option.days === since) }, option.label)
        button.addEventListener('click', () => go(withParam('since', option.days)))
        return button
      }),
    ),
    h('span', { class: 'label' }, 'Project'),
    picker,
  )
}

let overview: Overview | undefined
let overviewKey: string | undefined
const details = new Map<string, SessionDetail>()
let lastPath = ''
let renders = 0

async function renderRead(): Promise<void> {
  const token = ++renders
  const { path, params } = route()
  const view = path[0] ?? ''
  const filter = scope(params)
  const key = filter.toString()

  const links: Links = {
    session: (id) => href(`session/${encodeURIComponent(id)}`, filter),
    project: (name) => {
      const next = scope(params)
      next.set('project', name)
      return href('', next)
    },
    view: (name) => href(name, filter),
  }

  if (overview === undefined || key !== overviewKey) {
    main.classList.add('loading')
    const fetched = await getJSON<Overview>(`./api/overview?${key}`)
    if (token !== renders) return
    overview = fetched
    overviewKey = key
    context.textContent = fetched.root
  }
  drawChrome(view === 'session' ? 'sessions' : view, params, overview.projects)

  let nodes: Node[]
  if (view === 'session' && path[1]) {
    const id = path[1]
    let detail = details.get(id)
    if (!detail) {
      main.classList.add('loading')
      detail = await getJSON<SessionDetail>(`./api/session/${encodeURIComponent(id)}`)
      if (token !== renders) return
      details.set(id, detail)
    }
    nodes = sessionView(detail)
  } else if (view === 'findings') nodes = findingsView(overview)
  else if (view === 'sessions') nodes = sessionsView(overview, links, go)
  else if (view === 'projects') nodes = projectsView(overview, links, go)
  else nodes = overviewView(overview, links, go)

  main.classList.remove('loading')
  main.replaceChildren(...nodes)
  document.title = `thermal · ${view || 'overview'}`
  const pathKey = path.join('/')
  if (pathKey !== lastPath) window.scrollTo(0, 0)
  lastPath = pathKey
}

let live: Live | undefined
let liveText = ''

function renderLive(): void {
  if (!live) return
  const { path } = route()
  const selected = path[0] === 'request' && path[1] ? Number(path[1]) : null
  const scrollY = window.scrollY
  main.replaceChildren(...liveView(live, selected, (n) => go(`#/request/${n}`)))
  window.scrollTo(0, scrollY)
}

async function poll(): Promise<void> {
  try {
    const text = await (await fetch('./api/live')).text()
    // Redraw only on change: a redraw resets hover state and any open tooltip.
    if (text !== liveText) {
      liveText = text
      live = JSON.parse(text) as Live
      context.textContent = `proxy, forwarding to ${live.upstream}`
      renderLive()
    }
  } catch (error) {
    fail(error)
  }
  setTimeout(() => void poll(), 1000)
}

function rows(): HTMLTableRowElement[] {
  const primary = main.querySelector('table[data-nav="primary"]') ?? main.querySelector('table')
  return primary ? [...primary.querySelectorAll<HTMLTableRowElement>('tbody tr:not(.expanded)')] : []
}

function moveCursor(step: number): void {
  const all = rows()
  if (all.length === 0) return
  const at = all.findIndex((row) => row.classList.contains('cursor'))
  const next = all[Math.max(0, Math.min(all.length - 1, at + step))]
  all[at]?.classList.remove('cursor', 'selected')
  next?.classList.add('cursor', 'selected')
  next?.scrollIntoView({ block: 'nearest' })
}

function keyboard(mode: 'read' | 'proxy'): void {
  document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement
    const typing = target.matches('input, select, textarea')
    if (event.key === 'Escape') {
      if (help.open) return
      if (typing) target.blur()
      else if (route().path[0] === 'session') history.back()
      return
    }
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return

    if (event.key === '?') {
      if (help.open) help.close()
      else help.showModal()
    } else if (event.key === 'j') moveCursor(1)
    else if (event.key === 'k') moveCursor(-1)
    else if (event.key === 'Enter') main.querySelector<HTMLElement>('tr.cursor')?.click()
    else if (mode === 'read' && event.key === '/') {
      event.preventDefault()
      const search = main.querySelector<HTMLInputElement>('input[type="search"]')
      if (search) search.focus()
      else go(href('sessions', scope(route().params)))
    } else if (mode === 'read' && /^[1-4]$/.test(event.key)) {
      const view = VIEWS[Number(event.key) - 1]
      if (view) go(href(view.path, scope(route().params)))
    } else return
    event.preventDefault()
  })
}

async function start(): Promise<void> {
  const { mode } = await getJSON<{ mode: 'read' | 'proxy' }>('./api/mode')
  keyboard(mode)

  if (mode === 'proxy') {
    filters.hidden = true
    nav.hidden = true
    window.addEventListener('hashchange', renderLive)
    await poll()
    return
  }

  window.addEventListener('hashchange', () => void renderRead().catch(fail))
  await renderRead()
}

start().catch(fail)

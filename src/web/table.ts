import { h, type Child } from './dom.ts'

export interface Column<T> {
  label: string
  num?: boolean
  className?: string
  cell: (row: T) => Child
  /** Present when the column can be sorted by clicking its head. */
  sort?: (row: T) => number | string
}

interface TableOptions<T> {
  open?: (row: T) => void
  /** Content for a detail row that toggles open beneath the row. */
  expand?: (row: T) => Node
  sortBy?: { column: number; descending: boolean }
  limit?: number
  /** Marks the table that j/k and enter drive when several are on screen. */
  primary?: boolean
  selected?: (row: T) => boolean
}

export function table<T>(rows: T[], columns: Column<T>[], options: TableOptions<T> = {}): HTMLTableElement {
  let sortBy = options.sortBy
  const body = h('tbody')
  const element = h('table', { 'data-nav': options.primary ? 'primary' : 'secondary' })
  const heads: HTMLTableCellElement[] = []

  const draw = () => {
    const sortColumn = sortBy ? columns[sortBy.column] : undefined
    const ordered = sortColumn?.sort
      ? [...rows].sort((a, b) => {
          const key = sortColumn.sort as (row: T) => number | string
          const [x, y] = [key(a), key(b)]
          const order = x < y ? -1 : x > y ? 1 : 0
          return sortBy?.descending ? -order : order
        })
      : rows
    heads.forEach((th, index) => {
      if (sortBy?.column === index) th.setAttribute('aria-sort', sortBy.descending ? 'descending' : 'ascending')
      else th.removeAttribute('aria-sort')
    })
    const visible = options.limit === undefined ? ordered : ordered.slice(0, options.limit)

    body.replaceChildren(
      ...visible.map((row) => {
        const tr = h(
          'tr',
          { class: [options.open || options.expand ? 'link' : '', options.selected?.(row) ? 'selected' : ''].join(' ').trim() || undefined },
          ...columns.map((column) =>
            h('td', { class: [column.num ? 'num' : '', column.className ?? ''].join(' ').trim() || undefined }, column.cell(row)),
          ),
        )
        if (options.open) tr.addEventListener('click', () => options.open?.(row))
        if (options.expand) {
          tr.setAttribute('aria-expanded', 'false')
          tr.addEventListener('click', () => {
            const next = tr.nextElementSibling
            if (next?.classList.contains('expanded')) {
              next.remove()
              tr.setAttribute('aria-expanded', 'false')
              return
            }
            const detail = options.expand?.(row)
            tr.after(h('tr', { class: 'expanded' }, h('td', { colspan: columns.length }, detail)))
            tr.setAttribute('aria-expanded', 'true')
          })
        }
        return tr
      }),
    )
  }

  const head = h(
    'tr',
    {},
    ...columns.map((column, index) => {
      const th = h('th', { class: column.num ? 'num' : undefined, scope: 'col' })
      heads.push(th)
      if (!column.sort) {
        th.append(column.label)
        return th
      }
      const button = h('button', { type: 'button' }, column.label)
      button.addEventListener('click', () => {
        sortBy = { column: index, descending: sortBy?.column === index ? !sortBy.descending : true }
        draw()
      })
      th.append(button)
      return th
    }),
  )

  element.append(h('thead', {}, head), body)
  draw()
  return element
}

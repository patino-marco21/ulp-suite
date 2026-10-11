import { Fragment, type ReactNode } from 'react'
import { parseSafeHtml, type SafeNode } from '@/lib/safe-html'

function render(nodes: SafeNode[], keyPrefix = ''): ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}${i}`
    if (node.type === 'text') return <Fragment key={key}>{node.text}</Fragment>
    if (node.type === 'br') return <br key={key} />
    const children = render(node.children, `${key}.`)
    switch (node.tag) {
      case 'a':
        return node.href ? (
          <a key={key} href={node.href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
            {children}
          </a>
        ) : (
          <span key={key}>{children}</span>
        )
      case 'b':
      case 'strong':
        return <strong key={key}>{children}</strong>
      case 'i':
      case 'em':
        return <em key={key}>{children}</em>
      case 'p':
        // A block span, not a <p>: this component is already inside a paragraph-sized container and <p> must not nest.
        return <span key={key} className="block mb-2">{children}</span>
    }
  })
}

/** A third-party description (HTML from the HIBP sync or the breach editor) shown as text and a few safe elements. Never innerHTML. */
export function SafeDescription({ html, className }: { html: string; className?: string }) {
  return <div className={className}>{render(parseSafeHtml(html))}</div>
}

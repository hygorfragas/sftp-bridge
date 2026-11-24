import type { ComponentChildren } from 'preact'

function renderInline(text: string): ComponentChildren[] {
  const nodes: ComponentChildren[] = []
  const tokenRe = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index))
    }
    const token = match[0]
    if (token.startsWith('`')) {
      nodes.push(<code class="md-inline-code">{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(<strong>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('*') || token.startsWith('_')) {
      nodes.push(<em>{token.slice(1, -1)}</em>)
    } else if (token.startsWith('[') && match[2] && match[3]) {
      const url = match[3]
      nodes.push(
        <a
          class="md-link"
          href={url}
          onClick={(e) => {
            e.preventDefault()
            void orca.shell?.openExternal(url).catch(() => undefined)
          }}
        >
          {match[2]}
        </a>
      )
    }
    lastIndex = tokenRe.lastIndex
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }
  return nodes
}

export function MarkdownPreview({ content }: { content: string }) {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const blocks: ComponentChildren[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code block
    if (line.trim().startsWith('```')) {
      const lang = line.trim().slice(3).trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      i++ // skip closing fence
      blocks.push(
        <pre key={`code-${i}`} class="md-pre">
          {lang && <div class="md-code-lang">{lang}</div>}
          <code>{codeLines.join('\n')}</code>
        </pre>
      )
      continue
    }

    // Empty line
    if (!line.trim()) {
      i++
      continue
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      blocks.push(<hr key={`hr-${i}`} class="md-hr" />)
      i++
      continue
    }

    // Heading
    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      const level = heading[1].length
      const contentNodes = renderInline(heading[2])
      blocks.push(
        <div key={`h-${i}`} class={`md-h md-h${level}`}>
          {contentNodes}
        </div>
      )
      i++
      continue
    }

    // Blockquote
    if (line.trim().startsWith('>')) {
      const qLines: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        qLines.push(lines[i].trim().replace(/^>\s?/, ''))
        i++
      }
      blocks.push(
        <blockquote key={`bq-${i}`} class="md-quote">
          {renderInline(qLines.join(' '))}
        </blockquote>
      )
      continue
    }

    // Unordered or ordered list
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line)
      const items: ComponentChildren[] = []
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        const text = lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, '')
        items.push(<li key={`li-${i}`}>{renderInline(text)}</li>)
        i++
      }
      blocks.push(
        ordered ? (
          <ol key={`ol-${i}`} class="md-list">
            {items}
          </ol>
        ) : (
          <ul key={`ul-${i}`} class="md-list">
            {items}
          </ul>
        )
      )
      continue
    }

    // Pipe table
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]+$/.test(lines[i + 1])) {
      const parseRow = (row: string) =>
        row
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim())
      const headers = parseRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(parseRow(lines[i]))
        i++
      }
      blocks.push(
        <div key={`tbl-${i}`} class="md-table-wrap">
          <table class="md-table">
            <thead>
              <tr>
                {headers.map((h, idx) => (
                  <th key={idx}>{renderInline(h)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, rIdx) => (
                <tr key={rIdx}>
                  {r.map((c, cIdx) => (
                    <td key={cIdx}>{renderInline(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      continue
    }

    // Paragraph
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trim().startsWith('```') &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !lines[i].trim().startsWith('>') &&
      !/^\s*([-*+]|\d+\.)\s+/.test(lines[i])
    ) {
      para.push(lines[i])
      i++
    }
    blocks.push(
      <p key={`p-${i}`} class="md-p">
        {renderInline(para.join(' '))}
      </p>
    )
  }

  return <div class="md-preview">{blocks}</div>
}

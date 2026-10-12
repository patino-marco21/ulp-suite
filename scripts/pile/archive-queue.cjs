#!/usr/bin/env node
// Helper of scripts/pile/feed.sh for SOURCE=archive. Plain CommonJS, so the feeder needs no TypeScript runner.
//   archive-queue.cjs list  <archiveDir>                 one line per archived name: size <TAB> name <TAB> sha256 (the latest manifest entry of the name)
//   archive-queue.cjs write <archiveDir> <name> <dest>   writes the .archiveref file of <name> at <dest>
// Exit codes: 0 ok, 2 usage, 3 the manifest cannot be read or the name is not archived.
const fs = require('fs')
const path = require('path')

const [cmd, dir, name, dest] = process.argv.slice(2)

function latestByName(archiveDir) {
  let text
  try {
    text = fs.readFileSync(path.join(archiveDir, 'manifest.jsonl'), 'utf8')
  } catch (err) {
    console.error(`cannot read the manifest in ${archiveDir}: ${err.message}`)
    process.exit(3)
  }
  const byName = new Map()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (typeof entry.name === 'string') byName.set(entry.name, entry)
    } catch { /* a damaged line is skipped, like readManifest does */ }
  }
  return byName
}

if (cmd === 'list' && dir) {
  for (const e of latestByName(dir).values()) {
    if (/[\t\n\r]/.test(e.name)) continue // the feeder's queue is tab separated
    process.stdout.write(`${e.size}\t${e.name}\t${e.sha256}\n`)
  }
} else if (cmd === 'write' && dir && name && dest) {
  const e = latestByName(dir).get(name)
  if (!e) {
    console.error(`not archived: ${name}`)
    process.exit(3)
  }
  // One small write: the inbox watcher only claims a file whose size has stopped changing.
  fs.writeFileSync(dest, JSON.stringify({ v: 1, id: e.id, name: e.name, size: e.size, sha256: e.sha256 }) + '\n')
} else {
  console.error('usage: archive-queue.cjs list <archiveDir> | write <archiveDir> <name> <dest>')
  process.exit(2)
}

"use client"

import { useId, useRef, useState, type KeyboardEvent } from "react"
import { AlertTriangle, Circle, CircleCheck, CircleDashed, CircleX, MessageSquare, Plus } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { SiteLink } from "@/components/site-link"
import { Textarea } from "@/components/ui/textarea"
import { formatRelativeTime } from "@/lib/format-relative-time"
import {
  NO_MARK_LABEL, SITE_MARK_LABELS, SITE_MARK_NOTE_MAX, SITE_MARK_STATUSES, markAriaLabel, markTitle, normalizeNote,
  type SiteMark, type SiteMarkPatch, type SiteMarkStatus,
} from "@/lib/site-marks-input"

/**
 * The cell's box: one width for the header, the loading and failed states and the cell itself, so the columns line up. Wide enough for the pill with its
 * word from the sm width on; below it the pill is its icon alone.
 */
export const MARK_CELL = "w-12 sm:w-28 shrink-0 flex items-center justify-start"

/**
 * How each status looks wherever it is shown (design: docs/superpowers/specs/2026-11-21-mark-display-and-open-link-design.md): `pill` tints the cell's
 * pill, `edge` is the bar on the left of its row, `chosen` marks the button that is on in the editor. Every tint works on a light and a dark page.
 */
export const STATUS_STYLE: Record<SiteMarkStatus, { pill: string; edge: string; chosen: string }> = {
  done: { pill: "bg-green-500/15 text-green-700 dark:text-green-300", edge: "bg-green-500/70", chosen: "border-green-600/60 bg-green-500/15" },
  skip: { pill: "bg-red-500/15 text-red-700 dark:text-red-300", edge: "bg-red-500/70", chosen: "border-red-600/60 bg-red-500/15" },
  todo: { pill: "bg-blue-500/15 text-blue-700 dark:text-blue-300", edge: "bg-blue-500/70", chosen: "border-blue-600/60 bg-blue-500/15" },
}

/** The note box shows its counter from here to the limit. */
const COUNTER_FROM = SITE_MARK_NOTE_MAX - 100

/** The icon of a status. Shape tells the statuses apart as well as colour; no status is a faint dashed circle. */
export function MarkIcon({ status, className = "h-4 w-4" }: { status: SiteMarkStatus | null; className?: string }) {
  if (status === "done") return <CircleCheck className={`${className} text-green-600 dark:text-green-400`} aria-hidden />
  if (status === "skip") return <CircleX className={`${className} text-red-600 dark:text-red-400`} aria-hidden />
  if (status === "todo") return <Circle className={`${className} fill-current text-blue-600 dark:text-blue-400`} aria-hidden />
  return <CircleDashed className={`${className} text-muted-foreground`} aria-hidden />
}

/** The four choices of the menu, in the order shown: No mark first, then the statuses. */
const MENU_OPTIONS: Array<{ status: SiteMarkStatus | null; label: string }> = [
  { status: null, label: NO_MARK_LABEL },
  ...SITE_MARK_STATUSES.map(status => ({ status, label: SITE_MARK_LABELS[status] })),
]

interface SiteMarkMenuProps {
  host: string
  mark: SiteMark | null
  /** The text of the note box. */
  draft: string
  onDraftChange: (text: string) => void
  onChoose: (status: SiteMarkStatus | null) => void
  onNoteKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void
}

/** What the cell opens: the four choices, the note, and who set the mark and when. */
export function SiteMarkMenu({ host, mark, draft, onDraftChange, onChoose, onNoteKeyDown }: SiteMarkMenuProps) {
  const noteId = useId()
  const current = mark?.status ?? null
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate font-mono text-xs" title={host}>{host}</p>
        <SiteLink host={host} label="Open site" />
      </div>
      <div className="grid grid-cols-2 gap-1" role="group" aria-label="Mark">
        {MENU_OPTIONS.map(({ status, label }) => (
          <button
            key={label}
            type="button"
            aria-pressed={current === status}
            onClick={() => onChoose(status)}
            className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted ${
              current !== status ? "" : status === null ? "border-primary bg-muted font-medium" : `${STATUS_STYLE[status].chosen} font-medium`
            }`}
          >
            <MarkIcon status={status} className="h-3.5 w-3.5 shrink-0" />
            {label}
          </button>
        ))}
      </div>
      <div className="space-y-1">
        <label htmlFor={noteId} className="text-[10px] uppercase tracking-wider text-muted-foreground">Note</label>
        <Textarea
          id={noteId}
          value={draft}
          maxLength={SITE_MARK_NOTE_MAX}
          onChange={event => onDraftChange(event.target.value)}
          onKeyDown={onNoteKeyDown}
          placeholder="Optional: why, or what you found"
          className="min-h-[7rem] resize-y text-xs"
        />
        <p className="flex justify-between gap-2 text-[10px] text-muted-foreground">
          <span>Saved when this closes. Ctrl+Enter closes it.</span>
          {draft.length >= COUNTER_FROM && <span className="tabular-nums">{draft.length} / {SITE_MARK_NOTE_MAX}</span>}
        </p>
      </div>
      {mark?.updated_by && mark.updated_at && (
        <p className="text-[10px] text-muted-foreground">Set by {mark.updated_by}, {formatRelativeTime(mark.updated_at)}</p>
      )}
    </div>
  )
}

interface SiteMarkCellProps {
  /** The key the mark is kept under: the host the counts name. */
  host: string
  mark: SiteMark | null
  /** Loading: the marks have not arrived; failed: they could not be loaded. Neither is ever shown as "No mark". */
  availability: "loading" | "ready" | "failed"
  onChange: (patch: SiteMarkPatch) => void
}

/** The cell between a site's name and its Rows: a pill with the word of its status (or "Note", or a dashed "Mark" when there is none), and a menu to change both. */
export function SiteMarkCell({ host, mark, availability, onChange }: SiteMarkCellProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState("")
  // The note as last stored or sent: the box is saved when its text differs from this.
  const savedNote = useRef("")

  if (availability === "loading") {
    return (
      <span className={MARK_CELL} role="status" aria-label="Loading the mark">
        <span className="h-2 w-2 animate-pulse rounded-full bg-muted-foreground/30" />
      </span>
    )
  }
  if (availability === "failed") {
    return (
      <span className={MARK_CELL} title="Marks could not be loaded">
        <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" aria-label="Marks could not be loaded" />
      </span>
    )
  }

  const status = mark?.status ?? null
  const note = mark?.note ?? null
  // A site with no mark at all shows a dashed pill only when the row is hovered, a key puts the focus on it or its menu is open, and always on a touch screen.
  const tone = status !== null ? STATUS_STYLE[status].pill
    : note ? "border text-muted-foreground"
    : "border border-dashed text-muted-foreground opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-70"
  const word = status !== null ? SITE_MARK_LABELS[status] : note ? "Note" : "Mark"

  const noteChanged = () => normalizeNote(draft) !== normalizeNote(savedNote.current)

  const flushNote = () => {
    if (!noteChanged()) return
    onChange({ note: draft })
    savedNote.current = draft
  }

  const handleOpenChange = (next: boolean) => {
    if (next) {
      const text = mark?.note ?? ""
      setDraft(text)
      savedNote.current = text
    } else {
      flushNote()
    }
    setOpen(next)
  }

  /** A mark button: saves the status, and an unsaved note with it in the same request, so nothing typed is lost. */
  const choose = (next: SiteMarkStatus | null) => {
    const withNote = noteChanged()
    if (next !== status || withNote) onChange(withNote ? { status: next, note: draft } : { status: next })
    savedNote.current = draft
    setOpen(false)
  }

  const onNoteKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      flushNote()
      setOpen(false)
    }
  }

  return (
    // The menu renders in a portal, but React still bubbles a click in a portal to the row's handler, which would open the row's detail: stop it here.
    <div className={MARK_CELL} onClick={event => event.stopPropagation()}>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            title={markTitle(mark)}
            aria-label={markAriaLabel(host, mark)}
            className={`inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-full px-1.5 text-xs font-medium transition-colors hover:ring-1 hover:ring-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-2 ${tone}`}
          >
            {status !== null ? <MarkIcon status={status} className="h-3.5 w-3.5" />
              : note ? <MessageSquare className="h-3.5 w-3.5" aria-hidden />
              : <Plus className="h-3.5 w-3.5" aria-hidden />}
            <span className="hidden sm:inline">{word}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 p-3">
          <SiteMarkMenu host={host} mark={mark} draft={draft} onDraftChange={setDraft} onChoose={choose} onNoteKeyDown={onNoteKeyDown} />
        </PopoverContent>
      </Popover>
    </div>
  )
}

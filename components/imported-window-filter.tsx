"use client"

import { useRef, useState, type ReactNode } from "react"
import { CalendarClock, ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { epochSecondsToIso, utcIsoToDisplay } from "@/lib/imported-range-client"
import {
  WINDOW_PRESETS, browserOffsetAt, checkLocalWindow, epochsToLocalInputs, localInputToEpoch, pillLabel, presetEpochs, windowSentence,
  type OffsetAt, type WindowSource,
} from "@/lib/imported-window"

/** The window as the fields hold it: `datetime-local` values in the browser's local time ('' = open), and what produced them. */
export interface ImportedWindowValue {
  after: string
  before: string
  /** The preset that filled the fields, null once the operator typed them. It only decides what the pill says. */
  source: WindowSource | null
}

export const EMPTY_IMPORTED_WINDOW: ImportedWindowValue = { after: '', before: '', source: null }

/** A preset the page owns (the Credentials page's "Since last export"). `resolve` returns the window to apply, or null when there is none (the page says why). */
export interface ExtraWindowPreset {
  key: 'since-last-export'
  label: string
  title?: string
  resolve: () => { after: string; before: string } | null
}

interface ImportedWindowFilterProps {
  value: ImportedWindowValue
  /** The window changed and should take effect: a preset, Enter, Apply, Clear, or the popover closing on a changed, valid value. */
  onChange: (next: ImportedWindowValue) => void
  extraPresets?: ExtraWindowPreset[]
  /** Shown at the bottom of the popover (for example, where the last export of this search ended). */
  note?: ReactNode
  offsetAt?: OffsetAt
  now?: () => number
}

const chipCls = "rounded-full border px-2.5 py-1 text-xs transition-colors"
const chipOff = "border-border bg-muted/40 text-muted-foreground hover:bg-muted"
const chipOn = "border-primary/30 bg-primary/10 text-primary font-medium"

/**
 * "Imported: any time" -- the imported-after / imported-before window as one pill that opens a popover (presets, both fields, Clear, Apply).
 * Design: docs/superpowers/specs/2026-10-18-imported-window-ux-design.md. A preset takes effect at once; typed dates on Enter, on Apply and
 * when the popover closes with a changed, valid value; Escape drops the edit. The fields are local time; the server works in UTC, shown under each.
 */
export function ImportedWindowFilter({ value, onChange, extraPresets = [], note, offsetAt = browserOffsetAt, now = Date.now }: ImportedWindowFilterProps) {
  const [open, setOpen] = useState(false)
  const [draftAfter, setDraftAfter] = useState(value.after)
  const [draftBefore, setDraftBefore] = useState(value.before)
  const escaped = useRef(false)

  const active = value.after !== '' || value.before !== ''
  const label = pillLabel({ after: value.after, before: value.before, preset: value.source }, new Date(now()).getFullYear())
  const sentence = windowSentence(value, offsetAt)
  const check = checkLocalWindow(draftAfter, draftBefore, offsetAt)
  const changed = draftAfter !== value.after || draftBefore !== value.before

  const utcOf = (text: string): string | null => {
    const epoch = localInputToEpoch(text, offsetAt)
    return epoch === null ? null : utcIsoToDisplay(epochSecondsToIso(epoch))
  }

  const take = (next: ImportedWindowValue) => {
    setDraftAfter(next.after)
    setDraftBefore(next.before)
    onChange(next)
    setOpen(false)
  }

  const commitDraft = () => {
    if (!check.ok) return
    if (changed) take({ after: draftAfter, before: draftBefore, source: null })
    else setOpen(false)
  }

  const onOpenChange = (next: boolean) => {
    if (next) {
      setDraftAfter(value.after)
      setDraftBefore(value.before)
    } else if (open) {
      // Closing is the "blur" of the whole control: keep a changed, valid edit; Escape and an invalid edit are dropped.
      const dropped = escaped.current || !check.ok || !changed
      escaped.current = false
      if (!dropped) onChange({ after: draftAfter, before: draftBefore, source: null })
    }
    setOpen(next)
  }

  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitDraft()
    }
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={sentence ? `Rows ${sentence.text}; the server uses ${sentence.utc}` : 'Only rows added to the database in a time window'}
          aria-label={label}
          className={`flex items-center gap-1.5 ${chipCls} ${active ? chipOn : open ? "border-border bg-muted text-foreground" : chipOff}`}
        >
          <CalendarClock className="h-3 w-3" />
          {label}
          <ChevronDown className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-80 max-h-[var(--radix-popover-content-available-height)] overflow-y-auto p-3 space-y-3"
        align="start"
        collisionPadding={8}
        onEscapeKeyDown={() => { escaped.current = true }}
      >
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Imported</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">Only rows added to the database in this window.</p>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {WINDOW_PRESETS.map(p => (
            <button
              key={p.key}
              type="button"
              onClick={() => take({ ...epochsToLocalInputs(presetEpochs(p.key, now(), offsetAt), offsetAt), source: p.key })}
              className={`${chipCls} ${value.source === p.key && active ? chipOn : chipOff}`}
            >
              {p.label}
            </button>
          ))}
          {extraPresets.map(p => (
            <button
              key={p.key}
              type="button"
              title={p.title}
              onClick={() => {
                const w = p.resolve()
                if (w) take({ ...w, source: p.key })
                else setOpen(false)
              }}
              className={`${chipCls} ${value.source === p.key && active ? chipOn : chipOff}`}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-2.5">
          <div className="space-y-1">
            <label htmlFor="imported-after" className="text-[10px] uppercase tracking-wider text-muted-foreground">Imported after</label>
            <Input
              id="imported-after"
              type="datetime-local"
              step={1}
              value={draftAfter}
              onChange={e => setDraftAfter(e.target.value)}
              onKeyDown={onEnter}
              className="h-7 text-xs font-mono"
            />
            {utcOf(draftAfter) && <p className="text-[10px] font-mono text-muted-foreground">= {utcOf(draftAfter)}</p>}
          </div>
          <div className="space-y-1">
            <label htmlFor="imported-before" className="text-[10px] uppercase tracking-wider text-muted-foreground">Imported before</label>
            <Input
              id="imported-before"
              type="datetime-local"
              step={1}
              value={draftBefore}
              onChange={e => setDraftBefore(e.target.value)}
              onKeyDown={onEnter}
              className="h-7 text-xs font-mono"
            />
            {utcOf(draftBefore) && <p className="text-[10px] font-mono text-muted-foreground">= {utcOf(draftBefore)}</p>}
          </div>
        </div>

        {!check.ok && <p role="alert" className="text-[11px] text-rose-600 dark:text-rose-400">{check.reason}</p>}

        <p className="text-[10px] text-muted-foreground">
          Matches rows added to the database after this time; a credential imported again later counts as added. These fields are your
          local time; the server works in UTC (shown under each field).
        </p>
        {note}

        <div className="sticky bottom-0 -mx-3 -mb-3 flex items-center justify-between gap-2 border-t border-border/50 bg-popover px-3 py-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            disabled={!active && draftAfter === '' && draftBefore === ''}
            onClick={() => take({ ...EMPTY_IMPORTED_WINDOW })}
          >
            Clear
          </Button>
          <Button type="button" size="sm" className="h-7 text-xs" disabled={!check.ok} onClick={commitDraft}>
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

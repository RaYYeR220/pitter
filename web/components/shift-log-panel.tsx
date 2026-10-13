'use client'

import { useState } from 'react'
import { copy } from '@/lib/copy'
import { useShiftLog } from '@/hooks/shift-log'
import { ProblemNote } from './notes'

export function ShiftLogPanel() {
  const log = useShiftLog()
  const [label, setLabel] = useState('')

  return (
    <section data-testid="shift-log" data-status={log.status} data-sync={log.sync}>
      <h2>{copy.shiftLog.heading}</h2>
      <p>{copy.shiftLog.intro}</p>
      <ProblemNote problem={log.problem} />
      {log.error === 'load_failed' ? <p className="note warn">{copy.shiftLog.loadFailed}</p> : null}
      {log.error === 'cannot_open' ? <p className="note bad">{copy.shiftLog.cantOpen}</p> : null}

      {log.status !== 'unlocked' ? (
        <button
          type="button"
          disabled={log.status === 'unlocking'}
          onClick={() => void log.unlock()}
          data-testid="unlock-log"
        >
          {log.status === 'unlocking' ? copy.shiftLog.unlocking : copy.shiftLog.unlock}
        </button>
      ) : (
        <>
          <p className="muted">{copy.shiftLog.storedAs}</p>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (log.startShift(label)) setLabel('')
            }}
          >
            <label>
              {copy.shiftLog.label}
              <input
                value={label}
                placeholder={copy.shiftLog.labelPlaceholder}
                onChange={(event) => setLabel(event.target.value)}
                data-testid="new-shift-label"
              />
            </label>
            <button type="submit" className="secondary" data-testid="new-shift">
              {copy.shiftLog.newShift}
            </button>
          </form>

          {log.log && log.log.shifts.length === 0 ? <p>{copy.shiftLog.empty}</p> : null}
          {log.log?.trimmed ? <p className="muted">{copy.shiftLog.trimmed}</p> : null}
          <ul className="plain">
            {log.log?.shifts.map((shift) => (
              <li key={shift.id} data-testid="shift-entry">
                <label>
                  {copy.shiftLog.label}
                  <input
                    value={shift.label}
                    onChange={(event) => log.editShift(shift.id, { label: event.target.value })}
                  />
                </label>
                <p className="muted">{copy.shiftLog.shiftOn(shift.startedAt)}</p>
                <label>
                  {copy.shiftLog.note}
                  <textarea
                    rows={3}
                    value={shift.note}
                    placeholder={copy.shiftLog.notePlaceholder}
                    onChange={(event) => log.editShift(shift.id, { note: event.target.value })}
                    data-testid="shift-note"
                  />
                </label>
                <p className="muted" data-testid="trail-count" data-count={shift.trail.length}>
                  {copy.shiftLog.points(shift.trail.length)}
                </p>
                {shift.trail.slice(-3).map((point) => (
                  <p key={point.at} className="muted">
                    {copy.shiftLog.point(point.lat, point.lon, point.at)}
                  </p>
                ))}
                <div className="row">
                  <button type="button" className="secondary" onClick={() => void log.addCurrentSpot(shift.id)}>
                    {copy.shiftLog.record}
                  </button>
                  <button type="button" className="secondary" onClick={() => log.removeShift(shift.id)}>
                    {copy.shiftLog.remove}
                  </button>
                </div>
                <p className="muted">{copy.shiftLog.recordHint}</p>
              </li>
            ))}
          </ul>

          <p className="muted" data-testid="log-sync">
            {log.sync === 'saving'
              ? copy.shiftLog.saving
              : log.sync === 'failed'
                ? copy.shiftLog.saveFailed
                : log.sync === 'unsaved'
                  ? copy.shiftLog.unsaved
                  : log.savedAt
                    ? copy.shiftLog.saved(log.savedAt)
                    : ''}
          </p>
          <div className="row">
            <button
              type="button"
              onClick={() => void log.save()}
              disabled={log.sync === 'saving'}
              data-testid="save-log"
            >
              {copy.shiftLog.save}
            </button>
            <button type="button" className="secondary" onClick={log.lock} data-testid="lock-log">
              {copy.shiftLog.lock}
            </button>
          </div>
        </>
      )}
    </section>
  )
}

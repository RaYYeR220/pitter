'use client'

import { useState } from 'react'
import { copy } from '@/lib/copy'
import { useShiftLog } from '@/hooks/shift-log'
import { ProblemNote } from './notes'
import { AsksAgain, Banner, Block } from './ui/notice'

export function ShiftLogPanel() {
  const log = useShiftLog()
  const [label, setLabel] = useState('')

  return (
    <Block
      id="shift-log"
      title={copy.shiftLog.heading}
      lede={copy.shiftLog.intro}
      testId="shift-log"
      data={{ 'data-status': log.status, 'data-sync': log.sync }}
      className="log"
    >
      <ProblemNote problem={log.problem} />
      {log.error === 'load_failed' ? (
        <Banner tone="wait">
          <p>{copy.shiftLog.loadFailed}</p>
        </Banner>
      ) : null}
      {log.error === 'cannot_open' ? (
        <Banner tone="stop" alert>
          <p>{copy.shiftLog.cantOpen}</p>
        </Banner>
      ) : null}

      {log.status !== 'unlocked' ? (
        <div className="actions">
          <button
            type="button"
            className="btn btn--ink"
            disabled={log.status === 'unlocking'}
            onClick={() => void log.unlock()}
            data-testid="unlock-log"
            aria-describedby="log-asks"
          >
            {log.status === 'unlocking' ? copy.shiftLog.unlocking : copy.shiftLog.unlock}
          </button>
          <AsksAgain id="log-asks">{copy.screen.log.asks}</AsksAgain>
        </div>
      ) : (
        <>
          <p className="mono">{copy.shiftLog.storedAs}</p>
          <form
            className="log__new"
            onSubmit={(event) => {
              event.preventDefault()
              if (log.startShift(label)) setLabel('')
            }}
          >
            <label className="field">
              <span>{copy.shiftLog.label}</span>
              <input
                className="input"
                value={label}
                placeholder={copy.shiftLog.labelPlaceholder}
                onChange={(event) => setLabel(event.target.value)}
                data-testid="new-shift-label"
              />
            </label>
            <button type="submit" className="btn btn--line" data-testid="new-shift">
              {copy.shiftLog.newShift}
            </button>
          </form>

          {log.log && log.log.shifts.length === 0 ? <p className="small dim">{copy.shiftLog.empty}</p> : null}
          {log.log?.trimmed ? <p className="mono">{copy.shiftLog.trimmed}</p> : null}
          <ul className="log__list">
            {log.log?.shifts.map((shift) => (
              <li key={shift.id} className="sheet-slip log__entry" data-testid="shift-entry">
                <label className="field">
                  <span>{copy.shiftLog.label}</span>
                  <input
                    className="input"
                    value={shift.label}
                    onChange={(event) => log.editShift(shift.id, { label: event.target.value })}
                  />
                </label>
                <p className="mono">{copy.shiftLog.shiftOn(shift.startedAt)}</p>
                <label className="field">
                  <span>{copy.shiftLog.note}</span>
                  <textarea
                    className="input"
                    rows={3}
                    value={shift.note}
                    placeholder={copy.shiftLog.notePlaceholder}
                    onChange={(event) => log.editShift(shift.id, { note: event.target.value })}
                    data-testid="shift-note"
                  />
                </label>
                <p className="small" data-testid="trail-count" data-count={shift.trail.length}>
                  {copy.shiftLog.points(shift.trail.length)}
                </p>
                {shift.trail.slice(-3).map((point) => (
                  <p key={point.at} className="mono">
                    {copy.shiftLog.point(point.lat, point.lon, point.at)}
                  </p>
                ))}
                <div className="log__buttons">
                  <button type="button" className="btn btn--quiet" onClick={() => void log.addCurrentSpot(shift.id)}>
                    {copy.shiftLog.record}
                  </button>
                  <button type="button" className="link" onClick={() => log.removeShift(shift.id)}>
                    {copy.shiftLog.remove}
                  </button>
                </div>
                <p className="mono">{copy.shiftLog.recordHint}</p>
              </li>
            ))}
          </ul>

          <p className="mono" data-testid="log-sync">
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
          <div className="log__buttons">
            <button
              type="button"
              className="btn btn--ink"
              onClick={() => void log.save()}
              disabled={log.sync === 'saving'}
              data-testid="save-log"
            >
              {copy.shiftLog.save}
            </button>
            <button type="button" className="btn btn--line" onClick={log.lock} data-testid="lock-log">
              {copy.shiftLog.lock}
            </button>
          </div>
        </>
      )}
    </Block>
  )
}

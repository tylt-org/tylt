import {resolve} from 'node:path'
import chalk from 'chalk'
import type {Command} from 'commander'
import {Tylt, formatDuration, formatSize} from '@tylt/core'
import {getGlobalOptions} from '../utils.js'

export function registerShowCommand(program: Command): void {
  program
    .command('show')
    .description('Show steps and runs in a workspace')
    .argument('<workspace>', 'Workspace name')
    .action(async (workspaceName: string, _options: Record<string, unknown>, cmd: Command) => {
      const {workdir, json} = getGlobalOptions(cmd)
      const workdirRoot = resolve(workdir)

      const tylt = new Tylt({workdir: workdirRoot})

      // Check for active daemon — show live status if running
      const lockInfo = await tylt.workspaceLock(workspaceName)
      if (lockInfo) {
        try {
          const client = await tylt.attach(workspaceName)
          const state = await client.status()
          await client.disconnect()

          // Steps arrive as a plain object after JSON serialization (not a Map)
          const stepsArray = Object.values(state.steps)

          if (json) {
            const steps = stepsArray.map(s => ({
              stepId: s.id,
              displayName: s.displayName,
              status: s.status,
              runId: s.runId,
              durationMs: s.durationMs,
              artifactSize: s.artifactSize
            }))
            console.log(JSON.stringify({live: true, session: {status: state.status, steps}}, null, 2))
          } else {
            console.log(chalk.yellow(`⟳ Live session (pid ${lockInfo.pid}, status: ${state.status})`))
            for (const step of stepsArray) {
              const statusColors: Record<string, typeof chalk.green> = {
                finished: chalk.green, running: chalk.yellow, failed: chalk.red
              }
              const statusColor = statusColors[step.status] ?? chalk.gray

              const duration = step.durationMs === undefined ? '-' : formatDuration(step.durationMs)
              console.log(`  ${step.displayName.padEnd(30)} ${statusColor(step.status.padEnd(10))} ${duration}`)
            }
          }

          return
        } catch (error) {
          if (!json) {
            const message = error instanceof Error ? error.message : String(error)
            console.error(chalk.yellow(`Could not connect to daemon (pid ${lockInfo.pid}): ${message}`))
          }

          // Fall through to disk-based display
        }
      }

      const ws = await tylt.workspace(workspaceName)
      const steps = await ws.show()

      const rows = steps.map(r => ({
        stepId: r.stepId,
        stepName: r.stepName,
        status: r.status,
        duration: r.durationMs === undefined
          ? (r.startedAt
            ? formatDuration(Date.now() - new Date(r.startedAt).getTime())
            : '-')
          : formatDuration(r.durationMs),
        size: r.artifactSize && r.artifactSize > 0 ? formatSize(r.artifactSize) : '-',
        date: r.finishedAt
          ? r.finishedAt.replace('T', ' ').replace(/\.\d+Z$/, '')
          : '-',
        runId: r.runId ?? '-'
      }))

      const totalSize = steps.reduce((sum, r) => sum + (r.artifactSize ?? 0), 0)

      if (rows.length === 0) {
        console.log(chalk.gray('No runs found in this workspace.'))
        return
      }

      if (json) {
        console.log(JSON.stringify(rows, null, 2))
        return
      }

      const stepWidth = Math.max('STEP'.length, ...rows.map(r => (r.stepName ? `${r.stepId} (${r.stepName})` : r.stepId).length))
      const statusWidth = Math.max('STATUS'.length, ...rows.map(r => r.status.length))
      const durationWidth = Math.max('DURATION'.length, ...rows.map(r => r.duration.length))
      const sizeWidth = Math.max('SIZE'.length, ...rows.map(r => r.size.length))
      const dateWidth = Math.max('FINISHED'.length, ...rows.map(r => r.date.length))

      console.log(chalk.bold(
        `${'STEP'.padEnd(stepWidth)}  ${'STATUS'.padEnd(statusWidth)}  ${'DURATION'.padStart(durationWidth)}  ${'SIZE'.padStart(sizeWidth)}  ${'FINISHED'.padEnd(dateWidth)}`
      ))
      for (const row of rows) {
        const stepLabel = row.stepName ? `${row.stepId} (${row.stepName})` : row.stepId
        const statusColor = row.status === 'success'
          ? chalk.green
          : (row.status === 'running' ? chalk.yellow : chalk.red)
        const statusText = statusColor(row.status)
        const statusPad = statusWidth + (statusText.length - row.status.length)
        const cols = [
          stepLabel.padEnd(stepWidth),
          statusText.padEnd(statusPad),
          row.duration.padStart(durationWidth),
          row.size.padStart(sizeWidth),
          row.date.padEnd(dateWidth)
        ]
        console.log(cols.join('  '))
      }

      if (rows.length > 1) {
        console.log(chalk.gray(`\n  Total: ${formatSize(totalSize)}`))
      }
    })
}

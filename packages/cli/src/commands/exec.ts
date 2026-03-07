import process from 'node:process'
import {dirname, resolve} from 'node:path'
import type {Command} from 'commander'
import {Tylt, ConsoleReporter} from '@tylt/core'
import {InteractiveReporter} from '../interactive-reporter.js'
import {loadConfig} from '../config.js'
import {getGlobalOptions} from '../utils.js'
import {resolveExecutor} from '../executor.js'

export function registerExecCommand(program: Command): void {
  program
    .command('exec')
    .description('Execute a single step in a workspace')
    .argument('<workspace>', 'Workspace name')
    .requiredOption('-f, --file <path>', 'Step definition file (YAML or JSON)')
    .option('--step <id>', 'Step ID (overrides file\'s id)')
    .option('--input <specs...>', 'Input steps (e.g. "extract" or "data=extract")')
    .option('--ephemeral', 'Don\'t commit run, stream stdout to terminal')
    .option('--force', 'Skip cache check')
    .option('--verbose', 'Stream container logs in real-time')
    .action(async (
      workspaceName: string,
      options: {file: string; step?: string; input?: string[]; ephemeral?: boolean; force?: boolean; verbose?: boolean},
      cmd: Command
    ) => {
      const {workdir, json} = getGlobalOptions(cmd)
      const workdirRoot = resolve(workdir)

      const runtime = await resolveExecutor()
      const reporter = json ? new ConsoleReporter() : new InteractiveReporter({verbose: options.verbose})

      const cwd = process.cwd()
      const config = await loadConfig(cwd)
      const tylt = new Tylt({runtime, reporter, workdir: workdirRoot, config, cwd})
      const stepFilePath = resolve(options.file)
      const step = await tylt.loadStep(stepFilePath, options.step)

      const onSignal = (signal: NodeJS.Signals) => {
        void (async () => {
          await runtime.killRunningContainers()
          process.kill(process.pid, signal)
        })()
      }

      process.once('SIGINT', onSignal)
      process.once('SIGTERM', onSignal)

      await tylt.exec(workspaceName, step, {
        inputs: options.input,
        ephemeral: options.ephemeral,
        force: options.force,
        pipelineRoot: dirname(stepFilePath)
      })
    })
}

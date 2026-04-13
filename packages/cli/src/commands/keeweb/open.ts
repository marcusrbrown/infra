import type {goke} from 'goke'

export const KEEWEB_URL = 'https://kw.igg.ms/'

type CliInstance = ReturnType<typeof goke>

export function getOpenerCommand(): string {
  return process.platform === 'darwin' ? 'open' : 'xdg-open'
}

export function registerKeewebOpen(cli: CliInstance): void {
  cli.command('keeweb open', 'Open KeeWeb in the default browser').action(async () => {
    console.log(KEEWEB_URL)

    const opener = getOpenerCommand()
    const openerPath = Bun.which(opener)

    if (!openerPath) {
      console.log(`No browser launcher found (${opener}). Open the URL above manually.`)
      return
    }

    const child = Bun.spawn([opener, KEEWEB_URL], {
      stdout: 'inherit',
      stderr: 'inherit',
    })

    await child.exited
  })
}

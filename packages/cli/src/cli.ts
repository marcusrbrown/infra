#!/usr/bin/env bun

const VERSION = '0.0.0'

function showHelp() {
  console.log(`infra ${VERSION}

Infrastructure management CLI

USAGE:
  infra [COMMAND] [OPTIONS]

COMMANDS:
  keeweb      KeeWeb deployment management
  help        Show this help message
  --help      Show this help message
  --version   Show version

EXAMPLES:
  infra --help
  infra --version
  infra keeweb
`)
}

function showVersion() {
  console.log(`infra ${VERSION}`)
}

const args = process.argv.slice(2)
const command = args[0]

if (!command || command === '--help' || command === 'help') {
  showHelp()
} else if (command === '--version') {
  showVersion()
} else if (command === 'keeweb') {
  console.error('keeweb: not yet implemented')
  process.exit(1)
} else {
  console.error(`error: unknown command '${command}'`)
  console.error('')
  showHelp()
  process.exit(1)
}

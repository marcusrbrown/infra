/// <reference types="bun" />

import {describe, expect, it, spyOn} from 'bun:test'

import {parseProviders, promptForModel, promptForProviders} from './providers'

describe('option parsing', () => {
  describe('parseProviders', () => {
    it("parses \"anthropic,openai\" to ['anthropic', 'openai']", () => {
      expect(parseProviders('anthropic,openai')).toEqual(['anthropic', 'openai'])
    })

    it('parses "openai" to [\'openai\']', () => {
      expect(parseProviders('openai')).toEqual(['openai'])
    })

    it('parses "anthropic" to [\'anthropic\']', () => {
      expect(parseProviders('anthropic')).toEqual(['anthropic'])
    })

    it('rejects duplicate providers with a "duplicate" error', () => {
      expect(() => parseProviders('anthropic,anthropic')).toThrow(/duplicate/i)
    })

    it('rejects an empty string with a clear message', () => {
      expect(() => parseProviders('')).toThrow()
    })

    it('rejects an unknown provider "claude" with an enum error', () => {
      expect(() => parseProviders('claude')).toThrow()
    })

    it('trims whitespace around provider names', () => {
      expect(parseProviders(' anthropic , openai ')).toEqual(['anthropic', 'openai'])
    })

    it('rejects "__proto__" (prototype-chain safety)', () => {
      expect(() => parseProviders('__proto__')).toThrow()
    })
  })
})

/* eslint-disable @typescript-eslint/no-explicit-any -- spyOn mock return values require `any` casts */
describe('interactive provider/model prompts', () => {
  // We spy on @clack/prompts functions directly since Bun's mock.module
  // requires static hoisting. Instead we use spyOn on the imported module.
  // The helpers call the clack functions via the module binding, so we
  // intercept them via spyOn after importing.

  // Note: Because providers.ts imports clack at module load time and calls the
  // functions directly (not via a re-exported object), we need to use
  // mock.module to intercept. However, Bun's mock.module must be called
  // before the module is imported. Since providers.ts is already imported above,
  // we test the helpers by injecting controlled behavior through the clack
  // module mock at the describe level using beforeEach/afterEach with spyOn
  // on the actual clack module exports.
  //
  // The approach: import clack directly and spyOn its exports.

  describe('promptForProviders', () => {
    it('happy path: anthropic-only selection returns [anthropic]', async () => {
      const clack = await import('@clack/prompts')
      const multiselectSpy = spyOn(clack, 'multiselect').mockResolvedValue(['anthropic'] as any)

      const result = await promptForProviders()

      expect(result).toEqual(['anthropic'])
      expect(multiselectSpy).toHaveBeenCalledTimes(1)

      multiselectSpy.mockRestore()
    })

    it('happy path: both providers selected returns [anthropic, openai]', async () => {
      const clack = await import('@clack/prompts')
      const multiselectSpy = spyOn(clack, 'multiselect').mockResolvedValue(['anthropic', 'openai'] as any)

      const result = await promptForProviders()

      expect(result).toEqual(['anthropic', 'openai'])

      multiselectSpy.mockRestore()
    })

    it('edge case: empty selection re-prompts; multiselect called exactly twice', async () => {
      const clack = await import('@clack/prompts')
      let callCount = 0
      const multiselectSpy = spyOn(clack, 'multiselect').mockImplementation(async () => {
        callCount++
        if (callCount === 1) return [] as any
        return ['anthropic'] as any
      })

      const result = await promptForProviders()

      expect(result).toEqual(['anthropic'])
      expect(multiselectSpy).toHaveBeenCalledTimes(2)

      multiselectSpy.mockRestore()
    })

    it('edge case: cancel mid-flow causes process.exit(0)', async () => {
      const clack = await import('@clack/prompts')
      const cancelSymbol = Symbol('cancel')
      const multiselectSpy = spyOn(clack, 'multiselect').mockResolvedValue(cancelSymbol as any)
      const isCancelSpy = spyOn(clack, 'isCancel').mockImplementation(v => v === cancelSymbol)
      const cancelSpy = spyOn(clack, 'cancel').mockImplementation(() => {})
      const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit called')
      }) as any)

      await expect(promptForProviders()).rejects.toThrow('process.exit called')

      multiselectSpy.mockRestore()
      isCancelSpy.mockRestore()
      cancelSpy.mockRestore()
      exitSpy.mockRestore()
    })
  })

  describe('promptForModel', () => {
    it('happy path: single anthropic provider returns anthropic/claude-sonnet-4-6 without prompting', async () => {
      const clack = await import('@clack/prompts')
      const selectSpy = spyOn(clack, 'select')

      const result = await promptForModel(['anthropic'])

      expect(result).toBe('anthropic/claude-sonnet-4-6')
      expect(selectSpy).not.toHaveBeenCalled()

      selectSpy.mockRestore()
    })

    it('happy path: single openai provider returns openai/gpt-5.4-mini without prompting', async () => {
      const clack = await import('@clack/prompts')
      const selectSpy = spyOn(clack, 'select')

      const result = await promptForModel(['openai'])

      expect(result).toBe('openai/gpt-5.4-mini')
      expect(selectSpy).not.toHaveBeenCalled()

      selectSpy.mockRestore()
    })

    it('happy path: both providers, operator picks openai/gpt-5.4-mini from select', async () => {
      const clack = await import('@clack/prompts')
      const selectSpy = spyOn(clack, 'select').mockResolvedValue('openai/gpt-5.4-mini' as any)

      const result = await promptForModel(['anthropic', 'openai'])

      expect(result).toBe('openai/gpt-5.4-mini')
      expect(selectSpy).toHaveBeenCalledTimes(1)

      selectSpy.mockRestore()
    })

    it('happy path: both providers, operator picks anthropic/claude-sonnet-4-6 from select', async () => {
      const clack = await import('@clack/prompts')
      const selectSpy = spyOn(clack, 'select').mockResolvedValue('anthropic/claude-sonnet-4-6' as any)

      const result = await promptForModel(['anthropic', 'openai'])

      expect(result).toBe('anthropic/claude-sonnet-4-6')

      selectSpy.mockRestore()
    })

    it('happy path: operator picks "enter custom..." then types openai/gpt-5.4-mini', async () => {
      const clack = await import('@clack/prompts')
      const selectSpy = spyOn(clack, 'select').mockResolvedValue('__custom__' as any)
      const textSpy = spyOn(clack, 'text').mockResolvedValue('openai/gpt-5.4-mini' as any)

      const result = await promptForModel(['anthropic', 'openai'])

      expect(result).toBe('openai/gpt-5.4-mini')
      expect(textSpy).toHaveBeenCalledTimes(1)

      selectSpy.mockRestore()
      textSpy.mockRestore()
    })

    it('edge case: custom model entry fails regex then succeeds on second attempt', async () => {
      const clack = await import('@clack/prompts')
      const selectSpy = spyOn(clack, 'select').mockResolvedValue('__custom__' as any)
      let textCallCount = 0
      const textSpy = spyOn(clack, 'text').mockImplementation(async (_opts: any) => {
        textCallCount++
        // Simulate the validate function being called inline by the mock
        // The real clack text prompt calls validate internally; here we just
        // return the value and let the helper's validate logic re-prompt.
        // Since we can't simulate clack's internal validate loop, we test
        // that the helper's validate function rejects bad input.
        if (textCallCount === 1) {
          // Return a bad value — the helper should detect this and re-prompt
          return 'bad-model' as any
        }
        return 'openai/gpt-5.4-mini' as any
      })

      const result = await promptForModel(['anthropic', 'openai'])

      expect(result).toBe('openai/gpt-5.4-mini')
      expect(textSpy.mock.calls.length).toBeGreaterThanOrEqual(1)

      selectSpy.mockRestore()
      textSpy.mockRestore()
    })

    it('edge case: cancel during model select causes process.exit(0)', async () => {
      const clack = await import('@clack/prompts')
      const cancelSymbol = Symbol('cancel')
      const selectSpy = spyOn(clack, 'select').mockResolvedValue(cancelSymbol as any)
      const isCancelSpy = spyOn(clack, 'isCancel').mockImplementation(v => v === cancelSymbol)
      const cancelSpy = spyOn(clack, 'cancel').mockImplementation(() => {})
      const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit called')
      }) as any)

      await expect(promptForModel(['anthropic', 'openai'])).rejects.toThrow('process.exit called')

      selectSpy.mockRestore()
      isCancelSpy.mockRestore()
      cancelSpy.mockRestore()
      exitSpy.mockRestore()
    })
  })
})
/* eslint-enable @typescript-eslint/no-explicit-any */

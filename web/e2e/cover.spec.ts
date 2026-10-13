import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { accountNumber, go, hashOf, signedIn, units } from './support/app'
import { attachAuthenticator, rawPrf, testPrfClientScript } from './support/authenticator'

const DOLLAR = 1_000_000n

/** Runs one weather check from the simulator panel, waiting out the server's spacing between checks. */
async function checkWeather(page: Page): Promise<{ payouts: number; records: string[] }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.getByTestId('weather-check').click()
    const done = page.getByTestId('weather-check-done')
    const failed = page.getByText('The weather check didn’t go through')
    await expect(done.or(failed)).toBeVisible({ timeout: 120_000 })
    if (await done.isVisible()) {
      const payouts = Number(await done.getAttribute('data-payouts'))
      const records = await done
        .getByTestId('record-link')
        .evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).href))
      return { payouts, records }
    }
    await page.waitForTimeout(21_000)
  }
  throw new Error('the weather check kept failing')
}

/** Sets the simulator's rain switch, whatever position an earlier run left it in. */
async function setRain(page: Page, wet: boolean): Promise<void> {
  const state = page.getByTestId('rain-state')
  await expect(page.getByTestId('make-it-rain')).toBeEnabled()
  if ((await state.getAttribute('data-wet')) !== String(wet)) await page.getByTestId('make-it-rain').click()
  await expect(state).toHaveAttribute('data-wet', String(wet))
  await expect(page.getByTestId('make-it-rain')).toBeEnabled()
}

test('sign up, get covered in the simulator area and get paid while it rains; then sign in again from nothing', async ({
  context,
  page,
}) => {
  const proof: Record<string, unknown> = {}
  await page.goto('/app')
  const authenticator = await attachAuthenticator(context, page)

  await test.step('one prompt creates the account and signs in', async () => {
    await page.getByTestId('sign-up').click()
    await signedIn(page)
    proof.account = await accountNumber(page)
    expect(await authenticator.credentials()).toHaveLength(1)
  })

  await test.step('practice dollars arrive', async () => {
    await page.getByTestId('practice-money').click()
    await expect(page.getByTestId('practice-money-done')).toBeVisible({ timeout: 90_000 })
    await expect.poll(() => units(page, 'balance'), { timeout: 60_000 }).toBeGreaterThanOrEqual(1000n * DOLLAR)
  })

  await test.step('the pool has room for cover', async () => {
    await go(page, 'The pool')
    await expect(page.getByTestId('pool-active')).toBeVisible()
    const active = await units(page, 'pool-active')
    proof.poolActiveBefore = active.toString()
    if (active < 100n * DOLLAR) {
      await page.getByTestId('pool-amount').fill('500')
      await page.getByTestId('pool-add').click()
      const added = page.getByTestId('pool-added')
      await expect(added).toBeVisible({ timeout: 90_000 })
      proof.poolDeposit = hashOf((await added.getByTestId('record-link').getAttribute('href')) ?? '')
    }
    await go(page, 'Cover')
    await signedIn(page)
  })

  await test.step('cover turns on in the simulator area', async () => {
    await page.getByTestId('use-simulator').click()
    await expect(page.getByTestId('area-label')).toHaveAttribute('data-key', '18446751804650688016')
    await setRain(page, false)
    await checkWeather(page)
    await expect(page.getByTestId('offer')).toBeVisible({ timeout: 60_000 })
    await page.getByTestId('why-price').locator('summary').click()
    await expect(page.getByTestId('why-price').locator('tr').first()).toBeVisible()

    await page.getByTestId('turn-on').click()
    await expect(page.getByTestId('cover')).toHaveAttribute('data-status', 'on')
    await expect(page.getByTestId('cover-headline')).toHaveText('Cover is on', { timeout: 90_000 })
    await expect(page.getByTestId('history-row')).toHaveCount(1, { timeout: 60_000 })
    const purchase = page.getByTestId('cover').getByTestId('record-link')
    proof.purchase = hashOf((await purchase.getAttribute('href')) ?? '')
  })

  await test.step('it rains, the weather is checked, and the payout arrives', async () => {
    await setRain(page, true)

    const start = Number(await page.getByTestId('history-row').first().getAttribute('data-start'))
    const wait = (start + 75) * 1000 - Date.now()
    if (wait > 0) await page.waitForTimeout(wait)

    const before = await units(page, 'balance')
    const check = await checkWeather(page)
    proof.weatherCheck = check.records.map(hashOf)
    expect(check.payouts).toBeGreaterThanOrEqual(1)
    await expect.poll(() => units(page, 'balance'), { timeout: 60_000 }).toBeGreaterThan(before)
    await expect.poll(() => units(page, 'paid'), { timeout: 60_000 }).toBeGreaterThan(0n)
    await expect(page.getByTestId('cover')).toHaveAttribute('data-raining', 'true')
    proof.paid = (await units(page, 'paid')).toString()
    proof.balanceBefore = before.toString()
    proof.balanceAfter = (await units(page, 'balance')).toString()
  })

  await test.step('cover turns off and the rain stops', async () => {
    await page.getByTestId('turn-off').click()
    await expect(page.getByTestId('cover')).toHaveAttribute('data-status', 'off')
    await setRain(page, false)
  })

  const address = proof.account as string
  const covers = await page.getByTestId('history-row').count()

  await test.step('with storage wiped, the passkey alone brings back the account and its cover', async () => {
    const origin = new URL(page.url()).origin
    await page.evaluate(async () => {
      localStorage.clear()
      sessionStorage.clear()
      for (const database of await indexedDB.databases()) if (database.name) indexedDB.deleteDatabase(database.name)
    })
    await authenticator.cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' })
    await context.clearCookies()
    await page.reload()

    await expect(page.getByTestId('account')).toHaveAttribute('data-status', 'signed_out')
    expect(await page.evaluate(() => localStorage.length)).toBe(0)
    await page.getByTestId('sign-in').click()
    await signedIn(page)
    expect(await accountNumber(page)).toBe(address)
    await expect(page.getByTestId('history-row')).toHaveCount(covers, { timeout: 60_000 })
    await expect.poll(() => units(page, 'balance')).toBe(BigInt(proof.balanceAfter as string))
  })

  await test.step('the private shift log is sealed on the device with its own prompt', async () => {
    const stored: Buffer[] = []
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().includes('/api/blobs/')) stored.push(request.postDataBuffer() ?? Buffer.alloc(0))
    })
    const prompts = (await authenticator.credentials())[0]!.signCount

    await page.getByTestId('unlock-log').click()
    await expect(page.getByTestId('shift-log')).toHaveAttribute('data-status', 'unlocked')
    await page.getByTestId('new-shift-label').fill('Lunch rush, old town')
    await page.getByTestId('new-shift').click()
    await page.getByTestId('shift-note').first().fill('Tips 31 zloty, soaked by 13:10')
    await page.getByTestId('save-log').click()
    await expect(page.getByTestId('shift-log')).toHaveAttribute('data-sync', 'saved')

    expect(stored.length).toBeGreaterThan(0)
    const body = Buffer.concat(stored).toString('latin1')
    for (const secret of ['Lunch rush', 'old town', 'Tips 31', 'zloty']) expect(body).not.toContain(secret)

    await page.getByTestId('lock-log').click()
    await expect(page.getByTestId('shift-entry')).toHaveCount(0)
    await page.getByTestId('unlock-log').click()
    await expect(page.getByTestId('shift-entry')).toHaveCount(1)
    await expect(page.getByTestId('shift-note').first()).toHaveValue('Tips 31 zloty, soaked by 13:10')
    expect((await authenticator.credentials())[0]!.signCount).toBe(prompts + 2)
  })

  mkdirSync('test-results', { recursive: true })
  writeFileSync('test-results/e2e-proof.json', JSON.stringify(proof, null, 2))
  console.log(JSON.stringify(proof, null, 2))
})

test('the shift log written in one browser opens in a fresh one with the same passkey', async ({ browser }) => {
  const seed = `pitter-e2e-${Date.now()}`
  const first = await browser.newContext()
  await first.addInitScript(testPrfClientScript(seed))
  const pageA = await first.newPage()
  await pageA.goto('/app')
  const authA = await attachAuthenticator(first, pageA)

  await pageA.getByTestId('sign-up').click()
  await signedIn(pageA)
  const address = await accountNumber(pageA)
  await pageA.getByTestId('unlock-log').click()
  await expect(pageA.getByTestId('shift-log')).toHaveAttribute('data-status', 'unlocked')
  await pageA.getByTestId('new-shift-label').fill('Evening, river side')
  await pageA.getByTestId('new-shift').click()
  await pageA.getByTestId('shift-note').first().fill('Route via the bridge, 9 drops')
  await pageA.getByTestId('save-log').click()
  await expect(pageA.getByTestId('shift-log')).toHaveAttribute('data-sync', 'saved')

  const [credential] = await authA.credentials()
  expect(credential).toBeDefined()

  const second = await browser.newContext()
  await second.addInitScript(testPrfClientScript(seed))
  const pageB = await second.newPage()
  await pageB.goto('/app')
  const authB = await attachAuthenticator(second, pageB)
  await authB.add(credential!)

  expect(await rawPrf(pageA, credential!.credentialId)).toMatch(/^[0-9a-f]{64}$/)
  expect(await rawPrf(pageB, credential!.credentialId)).toBeNull()

  await expect(pageB.getByTestId('account')).toHaveAttribute('data-status', 'signed_out')
  await pageB.getByTestId('sign-in').click()
  await signedIn(pageB)
  expect(await accountNumber(pageB)).toBe(address)

  await pageB.getByTestId('unlock-log').click()
  await expect(pageB.getByTestId('shift-log')).toHaveAttribute('data-status', 'unlocked')
  await expect(pageB.getByTestId('shift-entry')).toHaveCount(1)
  await expect(pageB.getByTestId('shift-note').first()).toHaveValue('Route via the bridge, 9 drops')

  await first.close()
  await second.close()
})

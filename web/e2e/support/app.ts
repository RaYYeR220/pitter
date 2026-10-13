import { expect, type Page } from '@playwright/test'

/** Reads a number of base units from an element's `data-units`. */
export async function units(page: Page, testId: string): Promise<bigint> {
  const value = await page.getByTestId(testId).getAttribute('data-units')
  return BigInt(value ?? '0')
}

export async function accountNumber(page: Page): Promise<string> {
  const address = await page.getByTestId('account-number').getAttribute('data-address')
  expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/)
  return address!
}

export async function signedIn(page: Page): Promise<void> {
  await expect(page.getByTestId('account')).toHaveAttribute('data-status', 'signed_in')
}

/** Navigates inside the app without reloading it, so the signed-in session stays in memory. */
export async function go(page: Page, name: 'Cover' | 'The pool' | 'For partners'): Promise<void> {
  await page.getByRole('navigation').getByRole('link', { name, exact: true }).click()
}

/** Collects the public record links on the page. */
export async function recordLinks(page: Page): Promise<string[]> {
  return page.getByTestId('record-link').evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).href))
}

export const hashOf = (link: string) => link.split('/tx/')[1] ?? link

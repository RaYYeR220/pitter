import { formatClock, formatCountdown, formatDollars, formatDuration, perMinute } from './format'

/**
 * Every sentence the app shows, in one place. Pages and components take their words from here and add
 * none of their own, so the voice stays one voice and a wording change is a change to this file.
 */
export const copy = {
  product: {
    name: 'Pitter',
    description: 'Rain cover you switch on for one shift. It pays you by the minute while heavy rain is falling.',
  },

  nav: {
    home: 'Pitter',
    cover: 'Cover',
    pool: 'The pool',
    docs: 'For partners',
    skip: 'Skip to the main part',
  },

  landing: {
    claim: 'Get paid while it’s still raining.',
    support:
      'Rain cover you switch on for one shift. It costs less than a cent a minute, and when heavy rain hits your area it pays you by the minute.',
    button: 'Turn cover on',
    practice: 'This is practice mode. The money here is practice money and has no value.',
  },

  status: {
    loading: 'Loading…',
    unreachable: 'We can’t reach the service right now. Check your connection and try again.',
    retry: 'Try again',
    unsupportedChain: 'This app is set up for a network it doesn’t support. It can’t be used until that is fixed.',
    chainUnreadable: 'We can’t read your balance and cover right now. They are safe; this page just can’t show them.',
    relayerLow: 'Sending is running low on our side. It still works; we have been warned.',
    relayerEmpty: 'We can’t send anything right now. Cover you already have still pays.',
    practiceBadge: 'Practice mode',
    publicRecord: 'public record',
    copied: 'Copied',
    copy: 'Copy',
    close: 'Close',
    cancel: 'Cancel',
    working: 'Working…',
  },

  account: {
    heading: 'Start in one step',
    intro:
      'No password and no email. Your phone keeps the key to your account, and you unlock it with your face or your finger.',
    start: 'Start with Face ID or fingerprint',
    signIn: 'Sign in with Face ID or fingerprint',
    signInAny: 'Sign in to a different account',
    haveAccount: 'I already have an account',
    signOut: 'Sign out',
    waiting: 'Waiting for Face ID or fingerprint…',
    accountNumber: 'Account number',
    passkeyLabel: (day: string) => `Pitter account, ${day}`,
    scope: (maxSpendPerHour: bigint, lengthSeconds: number) =>
      `While you are signed in, the app keeps cover on without asking again, for up to ${formatDollars(maxSpendPerHour)} an hour and for ${formatDuration(lengthSeconds)}. Cashing out always asks for Face ID or fingerprint.`,
    ended: {
      expired: 'Your sign-in ran out. Cover you already have keeps running and still pays. Sign in again to carry on.',
      idle: 'You were signed out because the app sat unused. Cover you already have still pays. Sign in again to carry on.',
      signed_out: 'You are signed out. Cover you already have still pays.',
    },
    confirm: {
      cash_out: 'Confirm with Face ID or fingerprint to cash out',
      pool_add: 'Confirm with Face ID or fingerprint to add to the pool',
      pool_leave: 'Confirm with Face ID or fingerprint to leave the pool',
      cover_over_limit: 'Confirm with Face ID or fingerprint: this costs more than your hourly limit',
    },
    problems: {
      prf_unavailable: {
        title: 'This device can’t keep your account yet',
        guidance: [
          'Your account key has to be kept by your phone or by a password manager that can hold one for this app. The one that just answered can’t.',
          'It works with: iPhone or iPad on iOS 18 or newer with iCloud Keychain, Android with Google Password Manager, a Mac on macOS 15 or newer, Windows 11 version 25H2 or newer, 1Password, Proton Pass, and a YubiKey 5.',
          'It doesn’t work with: a passkey saved only inside a Chrome profile, Bitwarden, or Dashlane.',
          'The quickest fix is to open this page on your phone. If a passkey was just saved, you can delete it: it can’t be used.',
        ],
      },
      cancelled: {
        title: 'Nothing happened',
        guidance: [
          'The Face ID or fingerprint prompt was closed before it finished. Nothing was changed. Try again when you are ready.',
        ],
      },
      unsupported: {
        title: 'This browser can’t sign you in',
        guidance: [
          'Signing in needs Face ID, a fingerprint or a screen lock, and this browser doesn’t offer one to the page.',
          'Open this page in Safari or Chrome on your phone.',
        ],
      },
      insecure: {
        title: 'This page isn’t loaded securely',
        guidance: ['Signing in only works on the app’s own https address. Open the app from there.'],
      },
      wrong_account: {
        title: 'That is a different account',
        guidance: ['The Face ID or fingerprint you used belongs to another account. Use the one you signed in with.'],
      },
      ended: {
        title: 'You are signed out',
        guidance: ['Sign in again to carry on. Cover you already have still pays.'],
      },
      unknown: {
        title: 'Signing in didn’t work',
        guidance: ['Something went wrong on this device. Try again, or open this page on your phone.'],
      },
    },
    openOnPhone: 'Open on your phone',
    openOnPhoneHint: 'Copy this address and open it on your phone:',
  },

  session: {
    remaining: (milliseconds: number) => `Signed in for ${formatCountdown(milliseconds)} more`,
    expiring: (milliseconds: number) =>
      `Your sign-in ends in ${formatCountdown(milliseconds)}. Sign in again to keep cover on.`,
    idle: (milliseconds: number) => `Signing out in ${formatCountdown(milliseconds)} unless you use the app`,
    spend: (spent: bigint, limit: bigint) => `${formatDollars(spent)} of ${formatDollars(limit)} used this hour`,
    renew: 'Sign in again',
  },

  area: {
    heading: 'Your area',
    none: 'Cover needs your area to know when it rains on you.',
    about: (place: string) => `About 5 km around ${place}`,
    coordinates: (lat: number, lon: number) =>
      `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? 'E' : 'W'}`,
    useLocation: 'Use where I am',
    locating: 'Finding where you are…',
    pickCity: 'Or choose a city',
    choose: 'Choose…',
    change: 'Change area',
    denied: 'Cover needs your area to know when it rains on you. Turn on location to start.',
    unavailable: 'We couldn’t find where you are. Choose a city instead.',
    unsupported: 'This browser can’t share where you are. Choose a city instead.',
    privacy: 'Only your area is used, never your exact spot.',
    simulator: 'Simulator area (practice)',
    simulatorNote: 'A made-up area where you control the rain. Nothing here is real weather.',
    yours: 'where you are',
  },

  cover: {
    heading: 'Cover',
    off: 'Cover is off',
    on: 'Cover is on',
    starting: 'Turning cover on…',
    turnOn: 'Turn cover on',
    turnOff: 'Turn cover off',
    costs: (premium: bigint, seconds: number) =>
      `costs ${formatDollars((premium * 60n) / BigInt(Math.max(seconds, 1)))} a minute`,
    pays: (ratePerSecond: bigint) =>
      `pays you ${formatDollars(perMinute(ratePerSecond))} for every minute of heavy rain`,
    offer: (premium: bigint, seconds: number, ratePerSecond: bigint) =>
      `Cover costs ${formatDollars((premium * 60n) / BigInt(Math.max(seconds, 1)))} a minute right now and pays you ${formatDollars(perMinute(ratePerSecond))} for every minute of heavy rain.`,
    heavyRain: 'Heavy rain means 1 mm an hour or more, checked against several weather sources.',
    payoutChoice: 'What cover pays',
    payoutOption: (ratePerSecond: bigint) => `${formatDollars(perMinute(ratePerSecond))} a minute of heavy rain`,
    dry: (premium: bigint, seconds: number) =>
      `No rain where you are. Cover is on and costs ${formatDollars((premium * 60n) / BigInt(Math.max(seconds, 1)))} a minute.`,
    raining: (ratePerSecond: bigint) =>
      `Heavy rain where you are. Cover is paying you ${formatDollars(perMinute(ratePerSecond))} a minute.`,
    waitingToStart: (start: number) => `Cover starts at ${formatClock(start)}.`,
    coveredUntil: (end: number) => `Paid up until ${formatClock(end)}.`,
    renews: 'The next 10 minutes are added on their own while cover is on.',
    noRefund: 'Minutes you have paid for stay on and still pay if it rains. They can’t be handed back.',
    turnedOff: (end: number) =>
      `Cover is off. The minutes you already paid for run until ${formatClock(end)} and still pay.`,
    gap: (from: number, to: number) => `You had no cover from ${formatClock(from)} to ${formatClock(to)}.`,
    stopped: {
      session_expired:
        'Your sign-in ran out, so no more cover is being added. Cover you already have still pays. Sign in again to turn cover on.',
      spend_limit: (limit: bigint) =>
        `Cover has cost ${formatDollars(limit)} this hour, the most it may without asking you. Cover you already have still pays.`,
      insufficient_balance: 'Your balance is too low for the next 10 minutes. Add money to turn cover on again.',
      location: 'We lost your area, so cover stopped being added. Cover you already have still pays.',
      unavailable:
        'We couldn’t add more cover after several tries. Cover you already have still pays. Try turning it on again.',
    },
    lock: {
      heading: 'Lock the price for my shift',
      intro: 'Pay once now for the whole shift, at today’s price, whatever the forecast does later.',
      length: 'Shift length',
      hours: (hours: number) => `${hours} hour${hours === 1 ? '' : 's'}`,
      getPrice: 'See the price',
      price: (premium: bigint, start: number, end: number) =>
        `${formatDollars(premium)} for cover from ${formatClock(start)} to ${formatClock(end)}.`,
      upTo: (maxPayout: bigint) => `It can pay you up to ${formatDollars(maxPayout)}.`,
      confirm: 'Lock the price for my shift',
      locked: (end: number) => `Your shift is locked until ${formatClock(end)}.`,
      validFor: (seconds: number) => `This price holds for ${formatDuration(seconds)}.`,
    },
  },

  accrual: {
    heading: 'This shift',
    paid: 'Paid to you',
    confirmed: 'Confirmed, on its way',
    provisional: 'Since the last weather check',
    provisionalNote: 'Not confirmed yet. It becomes final at the next weather check.',
    lastCheck: (at: number, raining: boolean) =>
      `Last weather check at ${formatClock(at)}: ${raining ? 'heavy rain' : 'no heavy rain'}.`,
    noCheck: 'The weather for your area hasn’t been checked yet. The first check comes within a few minutes.',
    cost: 'Cost of cover',
    none: 'No cover running.',
  },

  price: {
    heading: 'Why this price',
    intro: 'The price follows the forecast for your area: the more likely heavy rain is, the more cover costs.',
    slot: (start: number, end: number) => `${formatClock(start)} to ${formatClock(end)}`,
    chance: (probability: number) => `${formatChance(probability)} chance of heavy rain`,
    basis: {
      nowcast: 'from the 15-minute forecast',
      hourly: 'from the hourly chance of rain',
      floor: 'the lowest chance we price at',
    },
    expected: (expectedPayout: bigint) => `Expected payout: ${formatDollars(expectedPayout)}`,
    load: (loadBps: number) =>
      `Plus ${loadBps / 100}% on top, which goes to the people who back the pool and to running costs.`,
    total: (premium: bigint) => `Price: ${formatDollars(premium)}`,
    unavailable: 'The breakdown of this price isn’t available right now.',
    show: 'Why this price',
  },

  refusals: {
    area_full: 'Cover for this area is full right now. Try again in a few minutes.',
    pool_full: 'The pool is at its limit right now, so new cover is paused. Cover you already have still pays.',
    no_more_areas: 'Cover can’t start in a new area right now. Try again in a few minutes.',
    weather_silent:
      'We can’t confirm the weather right now, so new cover is paused. Cover you already have still pays.',
    quote_expired: 'That price ran out before it was confirmed. Ask for a fresh one.',
    too_small: 'That is too little cover to start. Choose a longer shift or a higher payout.',
    too_far: 'That shift ends too far ahead. Choose a shorter one.',
    too_soon: 'That start time has just passed. Cover starts on the next full minute.',
    too_long: 'That shift is too long. Cover can be locked for up to 12 hours.',
    too_large: 'That is more cover than one shift can carry. Choose a shorter shift or a lower payout.',
    rate_too_high: 'That payout is above the most on offer. Choose a lower one.',
    insufficient_balance: 'Your balance is too low for this cover. Add money first.',
    already_bought: 'You already have cover for these minutes.',
    price_unavailable:
      'We can’t work out a price right now because the forecast isn’t available. Try again in a few minutes.',
    busy: 'Too many requests just now. Try again in a moment.',
    service_unavailable: 'Cover can’t be sent right now. Nothing was taken from your balance. Try again in a moment.',
    network: 'You seem to be offline. Cover you already have still pays.',
    pending: 'Your cover was sent and is waiting to be confirmed.',
    failed: 'That didn’t go through. Nothing was taken from your balance.',
    invalid: 'That request wasn’t accepted. Nothing was taken from your balance.',
    unknown: 'Something went wrong on our side. Nothing was taken from your balance.',
    capacity: (available: bigint) => `Room left for this area: cover that pays up to ${formatDollars(available)}.`,
  },

  history: {
    heading: 'Your cover',
    empty: 'No cover yet. It will show here once you turn it on.',
    unavailable: 'We can’t load your cover right now.',
    row: (start: number, end: number) => `${formatClock(start)} to ${formatClock(end)}`,
    cost: (premium: bigint) => `cost ${formatDollars(premium)}`,
    paid: (paid: bigint) => `paid you ${formatDollars(paid)}`,
    status: {
      upcoming: 'starts soon',
      active: 'running',
      ended: 'ended, waiting for the last weather check',
      closed: 'finished',
    },
    totals: (cost: bigint, paid: bigint) => `In all: cost ${formatDollars(cost)}, paid you ${formatDollars(paid)}.`,
  },

  money: {
    balance: 'Your balance',
    balanceUnknown: 'We can’t read your balance right now.',
    add: 'Add money',
    addLive:
      'Adding money by card isn’t available yet. For now, money reaches your balance when it is sent to your account number.',
    addPractice: 'In practice mode you can get practice dollars from the simulator below.',
    cashOut: 'Cash out',
    cashOutIntro: 'Send money from your balance to another account number. There is no fee to send.',
    to: 'Send to (account number)',
    amount: 'Amount in dollars',
    all: 'All of it',
    invalidTo: 'That isn’t an account number. It starts with 0x and has 42 characters.',
    invalidAmount: 'Enter an amount in dollars, like 12.50.',
    tooMuch: 'That is more than your balance.',
    sameAccount: 'That is your own account number.',
    done: (amount: bigint) => `Cashed out ${formatDollars(amount)}.`,
    failed: 'The cash-out didn’t go through. Your balance is unchanged.',
    pending:
      'The cash-out was sent and is waiting to be confirmed. Check your balance in a minute before trying again.',
  },

  shiftLog: {
    heading: 'Private shift log',
    intro:
      'Your exact route, shift names and notes. It is locked on this phone with your Face ID or fingerprint before it is stored, so nobody else can read it, us included.',
    unlock: 'Unlock my shift log',
    unlocking: 'Waiting for Face ID or fingerprint…',
    lock: 'Lock',
    empty: 'Nothing logged yet.',
    newShift: 'Start a new shift entry',
    label: 'Shift name',
    labelPlaceholder: 'Tuesday lunch, city centre',
    note: 'Notes',
    notePlaceholder: 'Earnings, tips, anything you want to remember',
    save: 'Save',
    saved: (at: number) => `Saved at ${formatClock(at)}`,
    saving: 'Saving…',
    unsaved: 'Not saved yet',
    saveFailed: 'We couldn’t store your log right now. It is still here on this phone until you close the page.',
    loadFailed: 'We couldn’t fetch your stored log right now. Try again in a moment.',
    cantOpen: 'This log can’t be opened with the Face ID or fingerprint you used. Use the one it was saved with.',
    record: 'Add my exact spot',
    recordHint: 'Adds where you are right now to this shift. It stays inside the locked log.',
    points: (count: number) => `${count} spot${count === 1 ? '' : 's'} on the route`,
    point: (lat: number, lon: number, at: number) => `${formatClock(at)}: ${lat.toFixed(5)}, ${lon.toFixed(5)}`,
    trimmed: 'The oldest routes were dropped to keep the log small. Their names and notes are kept.',
    shiftOn: (at: number) => `Shift from ${formatClock(at)}`,
    remove: 'Delete this entry',
    storedAs: 'Stored under its own private number, which isn’t linked to your account number.',
  },

  practice: {
    heading: 'Simulator',
    label: 'Practice mode only. Nothing here is real weather or real money.',
    money: 'Get practice dollars',
    moneyDone: (amount: bigint | null) =>
      amount === null ? 'Practice dollars added.' : `${formatDollars(amount)} of practice money added.`,
    moneyLimited: 'This account already got practice dollars today. Try again tomorrow.',
    moneyFailed: 'We couldn’t add practice dollars right now.',
    rain: 'Make it rain in the simulator area',
    rainOn: 'It is raining in the simulator area.',
    rainOff: 'It is dry in the simulator area.',
    rainNote: 'The rain counts from the next weather check.',
    check: 'Check the weather now',
    checking: 'Checking the weather…',
    checked: (readings: number, payouts: number) =>
      `Weather checked: ${readings} area${readings === 1 ? '' : 's'} updated, ${payouts} payout${payouts === 1 ? '' : 's'} sent.`,
    checkedNothing: 'Weather checked. Nothing new to report.',
    checkFailed: 'The weather check didn’t go through. Try again in a moment.',
    useArea: 'Use the simulator area',
    unavailable: 'The simulator isn’t available here.',
  },

  weather: {
    fresh: (ageSeconds: number) => `Weather last checked ${formatDuration(ageSeconds)} ago.`,
    silent: 'We can’t confirm the weather right now, so new cover is paused. Cover you already have still pays.',
    unknown: 'We can’t tell when the weather was last checked.',
  },

  pool: {
    heading: 'The pool',
    intro:
      'The pool is the money that pays out when it rains. The people who back it earn the premiums and carry the payouts.',
    size: 'In the pool',
    active: 'Backing cover',
    inUse: 'In use',
    limit: 'The limit',
    inUseOf: (inUse: bigint, limit: bigint) => `${formatDollars(inUse)} of ${formatDollars(limit)}`,
    free: 'Free to leave',
    areas: 'In use by area',
    noAreas: 'No area has cover running right now.',
    areaLimit: 'Limit for one area',
    areaRow: (lat: number, lon: number, count: bigint) =>
      `Around ${lat.toFixed(2)}, ${lon.toFixed(2)}: ${count} cover${count === 1n ? '' : 's'} running`,
    totals: 'Since the start',
    premiums: 'Premiums',
    payouts: 'Payouts',
    fees: 'Fees',
    sold: (count: number) => `${count} cover${count === 1 ? '' : 's'} sold`,
    recent: 'Latest activity',
    recentRange: (blocks: number, seconds: number) =>
      `Covers the last ${blocks} blocks of the public record, about ${formatDuration(seconds)}. Older activity isn’t shown here.`,
    recentNone: 'Nothing in that time.',
    recentUnavailable: 'Latest activity can’t be loaded right now.',
    bought: (premium: bigint) => `Cover sold for ${formatDollars(premium)}`,
    settled: (paid: bigint) => `Payout of ${formatDollars(paid)}`,
    unavailable: 'We can’t read the pool right now.',
    position: {
      heading: 'Your share',
      signIn: 'Sign in to back the pool or see your share.',
      value: 'Worth now',
      none: 'You haven’t added anything to the pool.',
      add: 'Add to the pool',
      addIntro: 'Money you add starts backing cover straight away. There is no fee to send.',
      amount: 'Amount in dollars',
      added: (amount: bigint) => `Added ${formatDollars(amount)} to the pool.`,
      addFailed: 'That didn’t go through. Your balance is unchanged.',
      addPending: 'It was sent and is waiting to be confirmed. Check your share in a minute before trying again.',
      balance: (balance: bigint) => `Your balance: ${formatDollars(balance)}`,
    },
    leave: {
      heading: 'Leave the pool',
      intro: (noticeSeconds: number) =>
        `Leaving takes ${formatDuration(noticeSeconds)} of notice, so cover that is already sold stays backed. From the moment you ask, your money earns nothing more but still carries payouts until you take it out.`,
      ask: 'Ask to leave with all of it',
      waiting: (milliseconds: number) => `You can take your money out in ${formatCountdown(milliseconds)}.`,
      ready: (amount: bigint) => `Your notice is over. You can take out up to ${formatDollars(amount)} now.`,
      readyPartly: 'Part of it is still backing cover that hasn’t finished. Take the rest out when that cover ends.',
      take: 'Take my money out',
      cancel: 'Stay in the pool after all',
      asked: 'You have asked to leave.',
      taken: 'Your money is out of the pool and back in your balance.',
      cancelled: 'You are staying in the pool.',
      fee: 'Leaving is the one thing here that carries a network fee, paid in MON from your own account.',
      noFee:
        'Your account holds no MON, so leaving can’t be sent from it yet. There is no way to add MON from this page.',
      failed: 'That didn’t go through. Nothing changed.',
    },
  },

  docs: {
    heading: 'For partners and agents',
    intro:
      'A fleet, a delivery app or a software agent can buy cover for a rider with one paid HTTP request. No account and no key from us: the request pays for itself.',
    endpointHeading: 'Buy cover for someone',
    endpoint:
      'Send where and when the rider works, how much cover should pay per second of heavy rain, and the rider’s account number. Amounts are whole numbers of millionths of a dollar; times are unix seconds on a full minute.',
    stepsHeading: 'How a request goes',
    steps: [
      'Send the request with no payment. The answer is 402 with the price and how to pay it.',
      'Pay: an x402 client reads the 402 answer, signs the payment and sends the same request again with it attached.',
      'The answer is 200 with the cover’s number and its public record. From then on payouts go straight to the rider.',
    ],
    safeHeading: 'Safe to repeat',
    safe: 'A payment buys one cover, once. Sending the same paid request again returns the first answer; it never charges twice.',
    fieldsHeading: 'What to send',
    fields: {
      lat: 'Latitude of where the rider works.',
      lon: 'Longitude of where the rider works.',
      start: 'When cover starts, unix seconds on a full minute.',
      end: 'When cover ends. Up to 12 hours after the start.',
      rate: 'What cover pays per second of heavy rain, in millionths of a dollar. 2000 is $0.12 a minute.',
      holder: 'The rider’s account number. Payouts go here.',
    },
    refusalsHeading: 'When the answer is no',
    refusals:
      'A refusal says why in its code: the area is full, the pool is at its limit, the weather can’t be confirmed right now, or the shift is too long, too far ahead or too small. Nothing is charged for a refusal.',
    enabled: 'Paid cover over HTTP is switched on here.',
    disabled:
      'Paid cover over HTTP is switched off on this deployment. The address answers 503 until it is switched on.',
    quoteHeading: 'Ask for a price first',
    quote: 'To see a price without paying, ask for a quote. It is free and limited to a few requests a minute.',
    practiceHeading: 'Practice mode',
    practiceOn:
      'This deployment runs in practice mode. Its dollars are practice money with no value, handed out free in the app, and it has one simulator area where the rain is switched on and off by hand instead of coming from the weather sources. Everything else works exactly as it does live: the same prices, the same limits, the same payouts.',
    practiceOff: 'This deployment is live: real dollars and real weather. There is no simulator here.',
    simulatorArea: (lat: number, lon: number) =>
      `The simulator area is the one around latitude ${lat}, longitude ${lon}.`,
    healthHeading: 'Is it up?',
    health:
      'The health address reports the contracts in use, when the weather was last checked and whether sending is working.',
  },
} as const

function formatChance(probability: number): string {
  const percent = Math.max(0, Math.min(1, probability)) * 100
  if (percent >= 10 || Number.isInteger(percent)) return `${Math.round(percent)}%`
  return `${percent.toFixed(1).replace(/\.0$/, '')}%`
}

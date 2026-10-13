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

  /** Where the history and pool figures were read from. Shown small, under what they describe. */
  source: {
    indexer: 'History via Envio',
    behind: 'History may be a moment behind.',
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
    area_not_served: 'Cover isn’t offered in your area yet.',
    waiting_for_cover: 'You can collect once the cover that was running when you asked has ended.',
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
    payoutRecord: 'payout record',
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
    recentIndexed: 'The newest sales, payouts and weather checks on the public record.',
    recentEmpty: 'Nothing yet.',
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
      waitingForCover: 'You can collect once the cover that was running when you asked has ended.',
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

  footer: {
    line: 'Pitter is rain cover you switch on for one shift. Every payout follows several weather sources and comes from a shared pool.',
  },

  /** The landing page, past its claim. Every figure in the worked example is passed in, worked out by the pricing rule. */
  story: {
    heroExample: 'An example: heavy rain where you are',
    heroLabel: (amount: string) => `Example: ${amount} paid so far`,
    soFar: (seconds: number) => `${Math.floor(seconds / 60)} min ${seconds % 60} s of heavy rain so far`,
    perMark: 'One more cent at every mark',
    fine: 'No app to install. Sign in with Face ID or fingerprint.',
    how: {
      heading: 'A shift, in four moves',
      lede: 'Pitter is rain cover for people who work outside in shifts, couriers first. It runs by the minute, and it knows one kind of weather: heavy rain.',
      moves: (rates: readonly bigint[]) => [
        {
          time: '16:00',
          label: 'shift starts',
          verb: 'Switch on',
          text: 'Turn cover on when you start. It is bought ten minutes at a time at the price of the moment, and the next ten minutes are added on their own while it stays on. Turn it off and nothing more is bought.',
          rain: false,
        },
        {
          time: 'Every 5 minutes',
          label: 'weather check',
          verb: 'Ride',
          text: 'While you work, the weather in your area, about 5 km around you, is checked against several weather sources. You do nothing.',
          rain: false,
        },
        {
          time: '18:41',
          label: 'heavy rain arrives',
          verb: 'Get rained on',
          text: `Heavy rain means 1 mm an hour or more. Every minute of it counts at the amount you chose: ${listOf(rates.map((rate) => formatDollars(perMinute(rate))))} a minute.`,
          rain: true,
        },
        {
          time: '18:45',
          label: 'still raining',
          verb: 'Get paid',
          text: 'What the rain earned lands in your balance at the next weather check, while it is still raining. Nothing to fill in, nobody to call. Cash out when you like.',
          rain: false,
        },
      ],
    },
    worked: {
      heading: 'One rainy evening, worked through',
      lede: (rate: string) =>
        `Made-up weather, real prices. Warsaw, a dinner shift from 16:00 to 22:00, with cover paying ${rate} for every minute of heavy rain.`,
      chartLabel: 'Chart of the example shift. On a small screen, slide it sideways.',
      chartTitle: 'Rain in the area during the example shift, 16:00 to 22:00',
      chartDesc: (minutes: number, parts: number) =>
        `Rain stays under 1 mm an hour until 18:41, peaks at about 2.2 mm an hour near 18:52 and drops back under the line at 19:04. Cover runs from 16:00 to 22:00. The ${minutes} minutes above the line are paid in ${parts} parts, at the weather checks from 18:45 to 19:05.`,
      line: 'Heavy rain starts at this line: 1 mm an hour',
      on: 'cover on',
      lock: 'locks the rest',
      arrives: 'heavy rain arrives',
      counts: 'the count starts',
      eases: 'rain eases',
      off: 'cover off',
      paidLine1: (minutes: number, parts: number) => `paid for ${minutes} minutes, in ${parts} parts,`,
      paidLine2: 'while it was still raining',
      blocks: (count: number, amount: string) => `Pay as you go, ${count} blocks: ${amount}`,
      locked: (amount: string) => `Price locked until 22:00: ${amount}`,
      hint: 'Slide the chart sideways to follow the evening.',
      story: (n: {
        floorChance: number
        dryPerMinute: string
        blockCost: string
        blockMinutes: number
        eveningChance: number
        locked: string
        stormBlock: string
        wetMinutes: number
        cost: string
      }) => [
        `The afternoon is dry, so every slot is priced at the lowest chance of heavy rain there is, ${formatChance(n.floorChance)}. Cover costs ${n.dryPerMinute} a minute: ${n.blockMinutes} minutes for ${n.blockCost}.`,
        `At 16:50 the hourly forecast gives the evening a small chance of rain, ${formatChance(n.eveningChance)}. Locking the price from 17:00 to 22:00 costs ${n.locked}, and that price can no longer move.`,
        `At 18:30 the 15-minute forecast sees the rain coming. Bought then, the next ${n.blockMinutes} minutes would have cost ${n.stormBlock}. At 18:41 the rain crosses the line and stays above it for ${n.wetMinutes} minutes; each weather check in that stretch sends another part of the payout.`,
        `Had the rain missed, the shift would have cost ${n.cost} and paid nothing. That is the deal, and it is the whole deal.`,
      ],
      receiptLabel: 'What the example shift cost and what it paid',
      rows: {
        payWhen: '16:00 to 17:00',
        pay: (blocks: number, minutes: number, perMinuteCost: string) =>
          `Pay as you go, ${blocks} blocks of ${minutes} minutes at ${perMinuteCost} a minute`,
        lockWhen: '17:00 to 22:00',
        lock: 'Lock the price for my shift, bought at 16:50',
        rainWhen: '18:41 to 19:04',
        rain: (minutes: number, rate: string) => `Heavy rain, ${minutes} minutes at ${rate}`,
        total: 'Ahead when the shift ends',
      },
    },
    pool: {
      heading: 'Who pays when it rains',
      paragraphs: [
        'Payouts come from a shared pool. The people who back it put dollars in, and in return they earn what riders pay for cover.',
        'The pool never promises more than it holds. Before any cover is sold, the most it could ever pay is set aside. If that would take your area, or the whole pool, past its limit, the sale is refused and nothing is charged.',
        'Backers who want their money back give notice first, so the money behind cover already sold stays put.',
      ],
      button: 'See the pool',
      figureCaption: 'An example: one area in the rain',
      figureLine: (needed: string) =>
        `left under the limit. The next ten minutes of cover could pay up to ${needed}, so they were not sold.`,
      meterLabel: (used: string, limit: string) => `${used} of the ${limit} limit for this area is in use`,
      used: ' set aside for cover already sold',
      limit: ' the limit for this area',
    },
    nots: {
      heading: 'What it doesn’t do',
      items: [
        {
          title: 'It doesn’t refund minutes.',
          text: 'Minutes you have paid for stay on and still pay if it rains. Turn cover off and no more are bought.',
        },
        {
          title: 'It doesn’t pay for drizzle.',
          text: 'Under 1 mm an hour doesn’t count, however long it lasts. Neither does wind, cold or a slow night.',
        },
        {
          title: 'It doesn’t guess the weather.',
          text: 'If the weather can’t be confirmed, new cover pauses, and time that was never confirmed pays nothing.',
        },
        {
          title: 'It doesn’t sell what the pool can’t pay.',
          text: 'When your area reaches its limit, new cover there waits until some room frees up. Cover you already have still pays.',
        },
        {
          title: 'It doesn’t know exactly where you are.',
          text: 'Only your area of about 5 km is used. Your exact route stays locked on your phone, in a private shift log only you can open.',
        },
        {
          title: 'It isn’t insurance.',
          text: 'Pitter is cover you switch on by the minute, with its price, its limits and every payout shown as they happen.',
        },
      ],
    },
    questions: {
      heading: 'Questions',
      items: (rates: readonly bigint[], maxSpendPerHour: bigint, lengthSeconds: number) => [
        {
          q: 'How do I sign in?',
          a: 'With Face ID or your fingerprint. There is no app to install, no password and no email.',
        },
        {
          q: 'What does it cost?',
          a: 'The price follows the forecast for your area: the chance of heavy rain, times what cover would pay you, plus 25% on top for the people who back the pool and for running costs. The app shows that sum behind every price.',
        },
        {
          q: 'Pay as you go, or lock the price?',
          a: 'Pay as you go buys ten minutes at a time at the price of the moment, for as long as cover is on. Locking the price pays once for a whole shift of up to 12 hours, so the price can’t climb when the forecast turns.',
        },
        {
          q: 'How much am I paid?',
          a: `You choose: ${listOf(rates.map((rate) => formatDollars(perMinute(rate))))} for every minute of heavy rain. ${formatDollars(perMinute(rates[1] ?? rates[0] ?? 0n))} a minute is ${formatDollars(perMinute(rates[1] ?? rates[0] ?? 0n) * 60n)} an hour. A bigger payout costs more a minute.`,
        },
        {
          q: 'What does the app do without asking me?',
          a: `While you are signed in, for up to ${formatDuration(lengthSeconds)}, it keeps cover on without asking again, up to ${formatDollars(maxSpendPerHour)} an hour. Cashing out, adding to the pool and anything over that limit ask for Face ID or fingerprint every time.`,
        },
      ],
      practice: {
        q: 'Can I try it without real money?',
        a: 'Yes. Practice mode runs everything with practice dollars, and a simulator area where you make it rain yourself.',
      },
    },
    close: {
      heading: 'Turn it on when you start.',
      lede: 'If it rains where you are, the money starts counting.',
      examples: 'Every figure on this page is an example, not a promise about your shift.',
    },
  },

  /** The cover screen and the pool: captions, rows and the lines under the figures. */
  screen: {
    daylight: 'Daylight',
    daylightHint: 'Dark type on a light screen, easier to read in direct sun',
    session: {
      label: 'Your sign-in',
      scope: (maxSpendPerHour: bigint) =>
        `Keeps cover on without asking, up to ${formatDollars(maxSpendPerHour)} an hour. Cashing out and the pool ask for Face ID or fingerprint every time.`,
    },
    gate: {
      caption: 'paid to you for every minute of heavy rain where you are.',
      ended: {
        expired: 'Your sign-in ran out.',
        idle: 'Signed out after a while unused.',
        signed_out: 'You are signed out.',
      },
      endedLabel: 'No time left on your sign-in',
      endedCaption: 'left on your sign-in.',
      endedLeft: 'Nothing new is bought',
      endedRight: 'Sign in again to carry on',
    },
    state: {
      dry: 'No rain where you are.',
      raining: 'Heavy rain where you are. You are being paid.',
    },
    hair: {
      line: '1 mm an hour: where heavy rain starts',
      renews: (at: number) => `Next 10 minutes added at ${formatClock(at)}`,
      noMore: 'Cover is off, so nothing more is added',
      cent: (seconds: number) => `One more cent every ${seconds} second${seconds === 1 ? '' : 's'}`,
      final: 'Final at the next weather check',
      unconfirmed: 'The weather can’t be confirmed right now',
      paused: 'New cover is paused',
    },
    cap: {
      idle: 'paid to you for every minute of heavy rain. Choose your area to see what cover costs there.',
      pricing: 'paid to you for every minute of heavy rain. Working out the price for your area…',
      offer: (ratePerSecond: bigint) =>
        `a minute right now. Cover pays you ${formatDollars(perMinute(ratePerSecond))} for every minute of heavy rain.`,
      offerAgain: (costPerMinute: bigint, ratePerSecond: bigint) =>
        `Cover costs ${formatDollars(costPerMinute)} a minute right now and pays you ${formatDollars(perMinute(ratePerSecond))} for every minute of heavy rain.`,
      buying: 'Buying the first 10 minutes…',
      onSinceLabel: (start: number) => `On cover since ${formatClock(start)}`,
      dry: (start: number) => `on cover since ${formatClock(start)}.`,
      earnedLabel: (amount: string) => `${amount} paid and counting this shift`,
      raining: (ratePerSecond: bigint) =>
        `paid and counting this shift, at ${formatDollars(perMinute(ratePerSecond))} for every minute of heavy rain.`,
      summaryPaid: 'paid to you by the rain on your last shift.',
      summaryDry: 'paid on your last shift. No heavy rain reached your area.',
      room: (needed: bigint) =>
        `is all the room left for new cover here. Ten minutes at your payout could pay up to ${formatDollars(needed)}, so they weren’t sold and nothing was charged.`,
      meterLabel: (used: bigint, limit: bigint) =>
        `${formatDollars(used)} of the ${formatDollars(limit)} limit for this area is in use`,
      limit: 'limit',
      age: (seconds: number) => (seconds < 120 ? `${Math.round(seconds)} s` : `${Math.round(seconds / 60)} min`),
      silent: 'since the weather was last confirmed. We don’t guess: new cover waits until it is confirmed again.',
      notNow: 'for every minute of heavy rain, once cover can be sold here again.',
    },
    summary: {
      minutes: 'of heavy rain, paid for',
      cost: 'cost of cover on that shift',
    },
    dry: {
      cost: 'cost of cover on this shift so far',
      pays: 'a minute, paid to you if heavy rain starts',
    },
    offer: {
      cost: (minutes: number) => `for the next ${minutes} minutes`,
      pays: 'if heavy rain fills all of them',
    },
    rain: {
      minutes: (seconds: number) => `${Math.floor(seconds / 60)} min ${Math.floor(seconds % 60)} s`,
      minutesCaption: 'of heavy rain paid or counting',
      rateCaption: 'for every minute of it',
    },
    payout: {
      sub: 'for every minute of heavy rain',
      unit: 'a minute',
      minute: 'a minute',
    },
    balance: {
      empty: 'Add money to turn cover on',
      emptyPractice: 'Get practice dollars in the simulator below',
      reading: 'Reading…',
      unknown: 'Can’t read it now',
    },
    accrual: {
      title: (start: number, end: number) => `This shift, ${formatClock(start)} to ${formatClock(end)}`,
      paidSub: 'already in your balance',
      confirmedSub: 'confirmed by a weather check, being sent',
      countingSub: 'nothing since the last weather check',
      net: 'This shift, all in',
    },
    switch: {
      offSub: (blockSeconds: number) => `Bought ${Math.round(blockSeconds / 60)} minutes at a time`,
      onSub: 'Tap to turn it off',
      needArea: 'Choose your area to turn cover on.',
    },
    price: {
      expectedLabel: 'What the rain is expected to cost, from the chances above',
      perMinute: (costPerMinute: bigint) => `${formatDollars(costPerMinute)} a minute`,
      splitExpected: 'Expected payout',
      splitMargin: 'On top',
      barsLabel: (slots: number, top: number) =>
        `Chance of heavy rain in each of ${slots} quarter hours, at most ${formatChance(top)}`,
      barsTop: (top: number) => `Top of the scale ${formatChance(top)}`,
    },
    lastBought: (start: number, end: number) => `Cover from ${formatClock(start)} to ${formatClock(end)}:`,
    lock: {
      upTo: 'It can pay you up to',
      perMinute: 'That comes to',
      noPrompt: 'Inside your hourly limit, so it doesn’t ask again.',
    },
    money: {
      asks: 'Asks for Face ID or fingerprint',
      asksLong: 'Asks for Face ID or fingerprint, every time',
    },
    history: {
      paidAgainst: (premium: bigint) => `paid you, against a cost of ${formatDollars(premium)}`,
    },
    log: {
      asks: 'Asks for Face ID or fingerprint to open',
    },
    sim: {
      money: 'Practice money',
      rain: 'Simulator rain',
      check: 'Weather check',
      signIn: 'Sign in first.',
    },
    pool: {
      central: (city: string) => `Central ${city}`,
      stateNone: 'No cover is running right now.',
      stateDry: (areas: number) =>
        `Cover is running in ${areas} area${areas === 1 ? '' : 's'}, with no heavy rain in any of them.`,
      stateRaining: (wet: number, areas: number) =>
        `Heavy rain in ${wet} of ${areas} area${areas === 1 ? '' : 's'} with cover. The pool is paying.`,
      inUseLabel: (used: bigint) => `${formatDollars(used)} in use`,
      inUseCaption: 'in use right now: set aside so that every cover already sold can be paid in full.',
      meterLabel: (percent: string) => `${percent} of the pool’s limit is in use`,
      ofLimit: 'of the limit',
      room: 'left to sell',
      limitIs: 'limit',
      limitShare: (share: string) => `${share} of the money backing cover`,
      leaving: (amount: bigint) => (amount > 0n ? `${formatDollars(amount)} of it is leaving` : 'none of it is leaving'),
      activeSub: 'what the limits are measured against',
      freeSub: 'not set aside for any cover',
      areaLimitSub: (share: string) => `${share} of the money backing cover`,
      areasLede: (limit: bigint) =>
        `An area is about 5 km across. Each may have ${formatDollars(limit)} in use and no more; past that, a sale there is refused, whatever the price.`,
      tilesLabel: 'Areas with cover. Each tile fills as cover is sold there; its top edge is the limit.',
      tilePaying: (percent: string) => `${percent}, paying`,
      tileLabel: (name: string, used: bigint, limit: bigint, raining: boolean) =>
        `${name}: ${formatDollars(used)} of ${formatDollars(limit)} in use${raining ? ', heavy rain, paying' : ''}`,
      keyWell: 'Fills as cover is sold; the top edge is the limit',
      keyWet: 'Heavy rain now, paying',
      keyFull: 'At its limit',
      tableCaption: 'In use against the limit, area by area, fullest first',
      colArea: 'Area',
      colLimit: 'Against the limit',
      colRoom: 'Room left',
      colCovers: 'Covers running',
      paying: 'heavy rain, paying',
      rowMeter: (percent: string) => `${percent} of the limit in use`,
      totalsHeading: 'Premiums in, payouts out',
      totalsLede:
        'Backers earn what riders pay for cover and carry the payouts when it rains. These are the totals since the pool opened.',
      premiumsSub: 'paid by riders for cover',
      payoutsSub: 'paid to riders for heavy rain',
      feesSub: 'kept for running costs, out of the premiums',
      net: (net: bigint) => `Kept by the pool so far: ${formatDollars(net, { sign: true })}`,
      boughtLabel: 'Cover sold',
      settledLabel: 'Payout to a rider',
      weatherLabel: (wetSeconds: number) =>
        wetSeconds > 0 ? `Weather check: ${formatDuration(wetSeconds)} of heavy rain` : 'Weather check: no heavy rain',
      daysHeading: 'Day by day',
      daysCaption: 'Premiums, payouts and money added to the pool on each of the last seven days, in UTC',
      colDay: 'Day',
      colPremiums: 'Premiums',
      colPayouts: 'Payouts',
      colAdded: 'Added',
      colRatio: 'Paid out',
      ratio: (lossRatio: number | null) => (lossRatio === null ? '–' : `${Math.round(lossRatio * 100)}%`),
      ratioLabel: 'Payouts as a share of the day’s premiums',
      eventWhen: (id: bigint) => `cover number ${id}`,
      addAsks: 'Asks for Face ID or fingerprint, every time',
      leaveAsks: 'Asks for Face ID or fingerprint, every time',
    },
    leave: {
      step: (n: number) => `Step ${n} of 3`,
      askTitle: 'Ask to leave',
      askText: 'From the moment you ask, your money earns nothing more but still carries payouts.',
      waitTitle: 'Wait out the notice',
      waitText: (seconds: number) => `${formatDuration(seconds)}, so cover already sold stays backed.`,
      takeTitle: 'Take it out',
      takeText: 'Once the notice is over, your money goes back to your balance.',
    },
  },
} as const

function formatChance(probability: number): string {
  const percent = Math.max(0, Math.min(1, probability)) * 100
  if (percent >= 10 || Number.isInteger(percent)) return `${Math.round(percent)}%`
  return `${percent.toFixed(1).replace(/\.0$/, '')}%`
}

/** "a, b or c" */
function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`
}

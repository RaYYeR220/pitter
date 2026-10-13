import { judgeProbe, sealProbe } from './engine-probe'

console.log(JSON.stringify({ sealed: sealProbe(), judged: judgeProbe() }))

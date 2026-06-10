import { startHealthServer } from '../healthz.ts'

startHealthServer('ledger', Number(process.env.PORT ?? 3002))

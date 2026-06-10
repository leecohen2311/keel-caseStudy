import { startHealthServer } from '../healthz.ts'

startHealthServer('ingest', Number(process.env.PORT ?? 3001))

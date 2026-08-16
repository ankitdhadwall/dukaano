import 'reflect-metadata'
import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import helmet from 'helmet'
import { AppModule } from './app.module'
import { configureBodyParser } from './bootstrap'
import { assertSecretsAreStrong, corsOrigins, env } from './config/env'

async function bootstrap(): Promise<void> {
  assertSecretsAreStrong(env)

  // bodyParser: false so configureBodyParser can install one with our limit — see bootstrap.ts.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: false,
    bodyParser: false,
  })
  configureBodyParser(app)

  app.use(helmet())
  app.enableCors({ origin: corsOrigins(env), credentials: true })
  // Behind a load balancer, req.ip must reflect the client, not the proxy — rate limiting and
  // audit rows are both keyed on it.
  app.getHttpAdapter().getInstance().set('trust proxy', 1)
  app.enableShutdownHooks()

  await app.listen(env.PORT)
  new Logger('Bootstrap').log(`Dukaano API listening on :${env.PORT} [${env.NODE_ENV}]`)
}

void bootstrap()

import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants'
import { RequestMethod } from '@nestjs/common'
import { DiscoveryService, MetadataScanner } from '@nestjs/core'
import type { INestApplication } from '@nestjs/common'
import type { Permission } from '@dukaano/types'
import { PERMISSIONS_KEY, PUBLIC_KEY } from '../src/common/decorators'

export interface RouteInfo {
  readonly method: string
  readonly path: string
  readonly controller: string
  readonly handler: string
  readonly isPublic: boolean
  /** `undefined` = the route declared nothing, which is a build failure. */
  readonly permissions: Permission[] | undefined
}

const METHOD_NAMES: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
  [RequestMethod.ALL]: 'ALL',
}

/**
 * Enumerate every HTTP route the application exposes, with its authorization metadata.
 *
 * Built on Nest's DiscoveryService rather than the Express router, deliberately: Express changed
 * its internal router shape between v4 and v5, and a test that reaches into framework internals
 * breaks on upgrades for reasons unrelated to what it is asserting. This reads exactly the same
 * metadata the AuthGuard reads at runtime, so the two can never disagree about what a route
 * declared.
 *
 * This function is the foundation of two CI gates: tenant-isolation coverage, and default-deny.
 */
export function enumerateRoutes(app: INestApplication): RouteInfo[] {
  const discovery = app.get(DiscoveryService)
  const scanner = new MetadataScanner()
  const routes: RouteInfo[] = []

  for (const wrapper of discovery.getControllers()) {
    const { instance, metatype } = wrapper
    if (!instance || !metatype) continue

    const controllerPath = Reflect.getMetadata(PATH_METADATA, metatype) ?? ''
    const prototype = Object.getPrototypeOf(instance)

    for (const methodName of scanner.getAllMethodNames(prototype)) {
      const handler = prototype[methodName]
      const handlerPath = Reflect.getMetadata(PATH_METADATA, handler)
      if (handlerPath === undefined) continue // not a route handler

      const httpMethod = Reflect.getMetadata(METHOD_METADATA, handler) as number

      routes.push({
        method: METHOD_NAMES[httpMethod] ?? String(httpMethod),
        path: join(controllerPath, handlerPath),
        controller: metatype.name,
        handler: methodName,
        // Read from handler first, then controller — mirroring getAllAndOverride in the guard.
        isPublic:
          Reflect.getMetadata(PUBLIC_KEY, handler) ??
          Reflect.getMetadata(PUBLIC_KEY, metatype) ??
          false,
        permissions:
          Reflect.getMetadata(PERMISSIONS_KEY, handler) ??
          Reflect.getMetadata(PERMISSIONS_KEY, metatype),
      })
    }
  }

  return routes.sort((a, b) => `${a.path}${a.method}`.localeCompare(`${b.path}${b.method}`))
}

function join(controllerPath: string, handlerPath: string): string {
  const parts = [controllerPath, handlerPath].filter((p) => p && p !== '/')
  return `/${parts.join('/')}`.replace(/\/+/g, '/')
}

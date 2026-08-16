import { Controller, Get } from '@nestjs/common'
import { UNIT_CODES, UNIT_DEFINITIONS } from '@dukaano/types'
import { RequirePermission } from '../../common/decorators'

/**
 * Units are a **fixed platform list**, not shop data (blueprint A-7).
 *
 * There is no create/update/delete here and that is the design, not an omission. A shop-defined
 * unit would need its own precision rule, its own display name in two languages, and a migration
 * path for every product already using it — and the thing it would enable, unit conversion
 * ("sell 250 g out of a 1 kg pack"), is explicitly out of scope. A Kirana shop treats "Sugar
 * loose" and "Sugar 1 kg packet" as different products anyway, which is how they are modelled.
 *
 * Served from the API rather than hardcoded in each client so a future unit ships by deploying
 * the server, without an app-store release for the phones.
 */
@Controller('v1/units')
export class UnitsController {
  @RequirePermission()
  @Get()
  list() {
    return UNIT_CODES.map((code) => ({
      code,
      nameEn: UNIT_DEFINITIONS[code].nameEn,
      nameHi: UNIT_DEFINITIONS[code].nameHi,
      /** How many decimal places input may carry. 0 means whole numbers only (§25 E-22). */
      decimals: UNIT_DEFINITIONS[code].decimals,
    }))
  }
}

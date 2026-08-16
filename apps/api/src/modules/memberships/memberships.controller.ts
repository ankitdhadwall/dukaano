import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common'
import { inviteMemberSchema, updateMembershipSchema } from '@dukaano/validation'
import type { InviteMemberInput, UpdateMembershipInput } from '@dukaano/validation'
import { Audit, CurrentShop, CurrentUser, RequirePermission } from '../../common/decorators'
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe'
import type { RequestPrincipal } from '../../common/guards/types'
import { MembershipsService } from './memberships.service'

@Controller('v1/memberships')
export class MembershipsController {
  constructor(private readonly memberships: MembershipsService) {}

  @RequirePermission('employee.manage')
  @Get()
  list(@CurrentShop() shopId: string) {
    return this.memberships.list(shopId)
  }

  @RequirePermission('employee.manage')
  @Audit('member.invited', 'shop_membership')
  @Post()
  invite(
    @CurrentShop() shopId: string,
    @CurrentUser() principal: RequestPrincipal,
    @Body(new ZodValidationPipe(inviteMemberSchema)) body: InviteMemberInput,
  ) {
    return this.memberships.invite(shopId, principal.userId, body)
  }

  @RequirePermission('employee.manage')
  @Audit('member.updated', 'shop_membership')
  @Patch(':id')
  update(
    @CurrentShop() shopId: string,
    @Param('id') id: string,
    @CurrentUser() principal: RequestPrincipal,
    @Body(new ZodValidationPipe(updateMembershipSchema)) body: UpdateMembershipInput,
  ) {
    return this.memberships.update(shopId, id, principal.userId, body)
  }
}

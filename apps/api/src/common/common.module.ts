import { Global, Module } from '@nestjs/common'
import { PrismaService } from './prisma/prisma.service'
import { AuditService } from './audit/audit.service'

@Global()
@Module({
  providers: [PrismaService, AuditService],
  exports: [PrismaService, AuditService],
})
export class CommonModule {}

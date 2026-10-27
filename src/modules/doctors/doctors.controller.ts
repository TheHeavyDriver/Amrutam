import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { Public } from '../../common/auth/public.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import {
  availabilityQuerySchema,
  doctorIdSchema,
  listDoctorsQuerySchema,
} from './doctors.schemas.js';
import type { AvailabilityQuery, ListDoctorsQuery } from './doctors.schemas.js';
import { DoctorsService } from './doctors.service.js';
import type {
  AvailabilityListResponse,
  DoctorDetail,
  DoctorListResponse,
} from './doctors.types.js';

@Public()
@Controller('doctors')
export class DoctorsController {
  constructor(private readonly doctorsService: DoctorsService) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=30, stale-while-revalidate=30')
  list(
    @Query(new ZodValidationPipe(listDoctorsQuerySchema)) query: ListDoctorsQuery,
  ): Promise<DoctorListResponse> {
    return this.doctorsService.list(query);
  }

  @Get(':doctorId')
  @Header('Cache-Control', 'public, max-age=60, stale-while-revalidate=60')
  get(
    @Param('doctorId', new ZodValidationPipe(doctorIdSchema)) doctorId: string,
  ): Promise<DoctorDetail> {
    return this.doctorsService.getById(doctorId);
  }

  @Get(':doctorId/availability')
  @Header('Cache-Control', 'public, max-age=15, stale-while-revalidate=15')
  availability(
    @Param('doctorId', new ZodValidationPipe(doctorIdSchema)) doctorId: string,
    @Query(new ZodValidationPipe(availabilityQuerySchema)) query: AvailabilityQuery,
  ): Promise<AvailabilityListResponse> {
    return this.doctorsService.listAvailability(doctorId, query);
  }
}

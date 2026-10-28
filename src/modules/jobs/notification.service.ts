import { Injectable, Logger } from '@nestjs/common';

/**
 * Delivery boundary for outbound notifications. The assignment has no email or
 * SMS provider, so the default adapter records only non-sensitive routing
 * metadata. A production adapter (SES/Twilio/FCM) plugs in here without
 * changing transactional code. Recipients and encrypted tokens are never
 * logged.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  async deliverEmail(payload: Record<string, unknown>, eventId: string): Promise<void> {
    if (
      typeof payload.template !== 'string' ||
      !['verify_email', 'reset_password'].includes(payload.template) ||
      typeof payload.encryptedToken !== 'string' ||
      payload.encryptedToken.length < 16 ||
      typeof payload.expiresAt !== 'string' ||
      Number.isNaN(Date.parse(payload.expiresAt))
    ) {
      throw new Error('Malformed notification.email payload');
    }

    this.logger.log(
      { eventId, template: payload.template, adapter: 'logging' },
      'Email handed to notification adapter',
    );
  }

  async deliverReminder(payload: Record<string, unknown>, eventId: string): Promise<void> {
    if (
      typeof payload.reminderType !== 'string' ||
      !['24h', '1h'].includes(payload.reminderType) ||
      typeof payload.scheduledStart !== 'string' ||
      Number.isNaN(Date.parse(payload.scheduledStart))
    ) {
      throw new Error('Malformed consultation.reminder_due payload');
    }

    this.logger.log(
      { eventId, reminderType: payload.reminderType, adapter: 'logging' },
      'Consultation reminder handed to notification adapter',
    );
  }
}

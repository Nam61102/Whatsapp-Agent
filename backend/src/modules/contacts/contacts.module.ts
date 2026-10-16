import { Module } from '@nestjs/common';
import { ContactsService } from './contacts.service';
import { ContactsController } from './contacts.controller';
import { DeviceContactsService } from '../../shared/device-contacts.service';

@Module({
  controllers: [ContactsController],
  providers: [ContactsService, DeviceContactsService],
  exports: [ContactsService, DeviceContactsService],
})
export class ContactsModule {}

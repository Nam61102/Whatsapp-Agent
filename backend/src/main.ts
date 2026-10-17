import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { assertConfig } from './config-check';

dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  assertConfig(logger);
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    })
  );

  // Configure Swagger OpenAPI documentation
  const swaggerConfig = new DocumentBuilder()
    .setTitle('WhatsApp AI Assistant & Chat API')
    .setDescription(
      'Production-ready REST API for WhatsApp Multi-Session Management, Real-Time Messaging, and Google Gemini AI Intelligence.'
    )
    .setVersion('1.0.0')
    .addTag('Auth', 'User registration, authentication and JWT token management')
    .addTag('WhatsApp', 'WhatsApp Baileys connection, pairing code, QR authentication, sync and session lifecycle')
    .addTag('Chats', 'Conversation directory, chat retrieval, unread counts and read receipts')
    .addTag('Messages', 'Real-time message sending, historical chat messages and pagination')
    .addTag('Contacts', 'Contact book, phone number mapping, and group discovery')
    .addTag('AI', 'Gemini 2.5 AI dashboard insights, contact persona profiles, token usage and reply suggestions')
    .addTag('Extractions', 'Extracted structured memories (birthdays, meetings, tasks, topics)')
    .addTag('Settings', 'User preferences, message data retention policies, and notification configuration')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'Authorization',
        description: 'Enter your JWT token from /api/v1/auth/login or /api/v1/auth/register',
        in: 'header',
      },
      'JWT-auth'
    )
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document, {
    customSiteTitle: 'WhatsApp AI API Documentation',
    swaggerOptions: {
      persistAuthorization: true,
      docExpansion: 'list',
      filter: true,
    },
  });
  SwaggerModule.setup('docs', app, document, {
    customSiteTitle: 'WhatsApp AI API Documentation',
    swaggerOptions: {
      persistAuthorization: true,
      docExpansion: 'list',
      filter: true,
    },
  });

  const port = process.env.PORT || 3000;
  await app.listen(port, '0.0.0.0');
  logger.log(`WhatsApp AI Backend running on port ${port}`);
  logger.log(`Swagger OpenAPI Documentation available at /api/docs and /docs on port ${port}`);
}

bootstrap();

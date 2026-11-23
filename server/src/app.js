const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const swaggerUi = require('swagger-ui-express');
const mongoSanitize = require('express-mongo-sanitize');
const config = require('./config/env');
const requestLogger = require('./middleware/requestLogger');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const { limiters } = require('./middleware/rateLimit');
const healthRoutes = require('./modules/health/health.routes');
const authRoutes = require('./modules/auth/auth.routes');
const meRoutes = require('./modules/me/me.routes');
const eventsRoutes = require('./modules/events/events.routes');
const holdsRoutes = require('./modules/holds/holds.routes');
const organiserRoutes = require('./modules/organiser/organiser.routes');
const adminRoutes = require('./modules/admin/admin.routes');
const openapi = require('./docs/openapi');
const bookingsRoutes = require('./modules/bookings/bookings.routes');

function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY); // req.ip is the client, not the proxy, for per-IP limits
  app.use(requestLogger);
  // No upgrade-insecure-requests: it would break Swagger UI's assets on http://localhost.
  app.use(helmet({ contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } } }));
  app.use(
    cors({
      origin: config.CORS_ORIGIN,
      credentials: true, // NFR-8
      exposedHeaders: ['Retry-After', 'RateLimit-Limit', 'RateLimit-Remaining', 'Idempotent-Replayed', 'X-Request-Id'],
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(mongoSanitize()); // NFR-7: strips $-operators and dotted keys from user input

  app.use('/health', healthRoutes);
  // NFR-10: Swagger UI and the raw OpenAPI document.
  app.get('/docs/openapi.json', (req, res) => res.json(openapi));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: 'TicketRush API' }));
  app.use('/api/v1', limiters.allByIp()); // FR-17; per-user limits run inside authenticate
  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/me', meRoutes);
  app.use('/api/v1/events', eventsRoutes);
  app.use('/api/v1/holds', holdsRoutes);
  app.use('/api/v1/bookings', bookingsRoutes);
  app.use('/api/v1/organiser', organiserRoutes);
  app.use('/api/v1/admin', adminRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };

'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');

const env = require('./config/env');
const requestLogger = require('./middleware/requestLogger');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const healthRoutes = require('./routes/health.routes');
const apiRoutes = require('./routes');
const openapi = require('./docs/openapi');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', /^\d+$/.test(env.trustProxy) ? parseInt(env.trustProxy, 10) : env.trustProxy);

app.use(requestLogger);
app.use(helmet());
app.use(
  cors((req, cb) => {
    const origin = req.get('origin');
    // Allow non-browser clients (no Origin header), whitelisted origins, and same-origin
    // requests (e.g. Swagger UI served by this app).
    const sameOrigin = origin === `${req.protocol}://${req.get('host')}`;
    const allowed = !origin || sameOrigin || env.corsOrigins.includes(origin);
    cb(allowed ? null : new Error('Origin not allowed by CORS'), {
      origin: allowed,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Anonymous-Cart-ID'],
      exposedHeaders: ['X-Request-Id', 'X-Anonymous-Cart-ID'],
    });
  })
);
app.use(express.json({ limit: '10kb' }));

app.use('/health', healthRoutes);
if (env.enableDocs) {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapi));
}
app.use('/api/v1', apiRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;

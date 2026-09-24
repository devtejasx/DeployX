import express from 'express';
import cors from 'cors';
import config from './config/index.js';
import apiRoutes from './routes/index.js';
import { notFound } from './middleware/notFound.js';
import { errorHandler } from './middleware/errorHandler.js';

const app = express();

app.disable('x-powered-by');
app.use(cors({ origin: config.clientUrl }));
app.use(express.json());

app.use('/api', apiRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;

import express from 'express';
import usersRouter from './routes/users.js';
import ordersRouter from './routes/orders.js';

const app = express();
app.use('/users', usersRouter);
app.use('/orders', ordersRouter);
app.listen(3000);

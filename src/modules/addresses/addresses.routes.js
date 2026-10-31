'use strict';

const express = require('express');
const controller = require('./addresses.controller');
const authenticate = require('../../middleware/auth');
const validate = require('../../middleware/validate');
const { createSchema, updateSchema, addressParams } = require('./addresses.validation');

const router = express.Router();

router.use(authenticate);

router.post('/', validate(createSchema), controller.create);
router.get('/', controller.list);
router.get('/:id', validate(addressParams, 'params'), controller.get);
router.put('/:id', validate(addressParams, 'params'), validate(updateSchema), controller.update);
router.delete('/:id', validate(addressParams, 'params'), controller.remove);
router.patch('/:id/default', validate(addressParams, 'params'), controller.setDefault);

module.exports = router;

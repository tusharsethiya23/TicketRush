/**
 * Validates and replaces req.params, req.query and req.body with zod-parsed values (NFR-7).
 * Usage: validate({ body: schema, query: schema, params: schema })
 */
const validate = (schemas) => (req, res, next) => {
  try {
    for (const part of ['params', 'query', 'body']) {
      if (schemas[part]) req[part] = schemas[part].parse(req[part] ?? {});
    }
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = validate;

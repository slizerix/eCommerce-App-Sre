import { Router } from 'express';
import { pool } from '../db.js';
import { asyncHandler, HttpError } from '../util.js';
import { timeDbQuery } from '../observability/metrics.js';

const router = Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { search, category, sort } = req.query as {
      search?: string;
      category?: string;
      sort?: string;
    };
    const clauses: string[] = [];
    const params: (string | number)[] = [];

    if (search) {
      clauses.push('(LOWER(name) LIKE ? OR LOWER(description) LIKE ?)');
      const needle = `%${search.toLowerCase()}%`;
      params.push(needle, needle);
    }
    if (category) {
      clauses.push('category = ?');
      params.push(category);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const order = sort === 'price' ? 'ORDER BY price_cents ASC' : 'ORDER BY id DESC';

    // Two named queries because they degrade differently as data grows:
    //   - `products_list`: paged scan, cheap, indexed by id.
    //   - `products_search`: LIKE '%...%', no full-text index — degrades with row count.
    const queryName = search ? 'products_search' : 'products_list';
    const rows = await timeDbQuery(queryName, async () => {
      const [r] = await pool.execute<any[]>(
        `SELECT id, sku, name, category, price_cents, stock FROM products ${where} ${order} LIMIT 200`,
        params
      );
      return r;
    });
    res.json({ products: rows });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const [[row]] = await pool.execute<any[]>(
      'SELECT id, sku, name, description, category, price_cents, stock FROM products WHERE id = ?',
      [req.params['id']!]
    );
    if (!row) throw new HttpError(404, 'not_found');
    res.json({ product: row });
  })
);

// "Customers also bought" via self-join across orders. No supporting indexes
// on order_items.product_id — a realistic slow query that gets worse with
// order volume. We deliberately time it with its own query label so the
// histogram tells the story.
router.get(
  '/:id/related',
  asyncHandler(async (req, res) => {
    const rows = await timeDbQuery('products_related', async () => {
      const [r] = await pool.execute<any[]>(
        `
        SELECT p.id, p.name, p.price_cents, COUNT(*) AS co_purchase_count
        FROM order_items oi1
        JOIN order_items oi2 ON oi1.order_id = oi2.order_id AND oi1.product_id != oi2.product_id
        JOIN products p ON p.id = oi2.product_id
        WHERE oi1.product_id = ?
        GROUP BY p.id, p.name, p.price_cents
        ORDER BY co_purchase_count DESC
        LIMIT 5
        `,
        [req.params['id']!]
      );
      return r;
    });
    res.json({ related: rows });
  })
);

export default router;

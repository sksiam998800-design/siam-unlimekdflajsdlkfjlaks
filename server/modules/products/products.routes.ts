import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { ProductModel } from '../../database/models/Product';
import { AuthenticatedRequest, requireRole } from '../../middleware/auth';
import { requireDatabase } from '../../middleware/dbGuard';
import { escapeRegex } from '../../utils/regex';
import { logAuditActivity } from '../../utils/auditLogger';

export const productsRouter = Router();

// Apply requireDatabase to all product routes
productsRouter.use(requireDatabase);

const productVariantSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  sku: z.string().min(1),
  price: z.number().nonnegative().optional(),
  originalPrice: z.number().nonnegative().optional(),
  stock: z.number().int().nonnegative().default(0),
  options: z.record(z.string(), z.string()).optional(),
  attributes: z.record(z.string(), z.string()).optional(),
  image: z.string().optional(),
  barcode: z.string().optional(),
  isActive: z.boolean().optional().default(true),
});

const highlightSchema = z.object({
  label: z.string(),
  value: z.string(),
  icon: z.string().optional(),
});

const specificationSchema = z.object({
  label: z.string(),
  value: z.string(),
  group: z.string().optional(),
});

const faqSchema = z.object({
  question: z.string(),
  answer: z.string(),
});

const productInputSchema = z.object({
  name: z.string().min(2, 'Product name must be at least 2 characters'),
  subtitle: z.string().optional(),
  slug: z.string().min(2, 'Valid slug is required'),
  sku: z.string().min(2, 'SKU is required'),
  description: z.string().min(5, 'Description is required'),
  category: z.string().min(1, 'Category is required'),
  subcategory: z.string().optional(),
  brand: z.string().min(1, 'Brand is required'),
  basePrice: z.number().positive('Base price must be greater than 0'),
  salePrice: z.number().positive('Sale price must be greater than 0'),
  stock: z.number().int().nonnegative('Stock cannot be negative'),
  images: z.array(z.string()).min(1, 'At least one image is required'),
  variants: z.array(productVariantSchema).optional(),
  highlights: z.array(highlightSchema).optional(),
  specificationsTable: z.array(specificationSchema).optional(),
  faqs: z.array(faqSchema).optional(),
  specifications: z.record(z.string(), z.string()).optional(),
  attributes: z.record(z.string(), z.string()).optional(),
  badge: z.string().optional(),
  warranty: z.string().optional(),
  deliveryEstimate: z.string().optional(),
  tags: z.array(z.string()).optional(),
  banglaKeywords: z.array(z.string()).optional(),
  isTopSelling: z.boolean().optional(),
  isNewArrival: z.boolean().optional(),
  isBestRated: z.boolean().optional(),
  isTrending: z.boolean().optional(),
  isFeatured: z.boolean().optional(),
  status: z.enum(['active', 'draft', 'archived']).optional(),
});

// GET /api/products/suggestions?q=... (Autocomplete, limit max 8 with relevance ranking)
productsRouter.get('/suggestions', async (req: Request, res: Response) => {
  try {
    const q = ((req.query.q as string) || '').trim();
    if (!q || q.length < 2) {
      return res.json({ success: true, suggestions: [] });
    }

    // Limit query length to prevent abusive regex workloads
    const sanitizedQuery = q.slice(0, 100);
    const safeRegex = new RegExp(escapeRegex(sanitizedQuery), 'i');

    const products = await ProductModel.find({
      status: 'active',
      $or: [
        { name: safeRegex },
        { brand: safeRegex },
        { category: safeRegex },
        { sku: safeRegex },
        { banglaKeywords: { $in: [safeRegex] } },
      ],
    })
      .select('name slug salePrice basePrice images category brand stock rating reviewCount badge')
      .limit(16)
      .lean();

    const lowerQ = sanitizedQuery.toLowerCase();

    // Compute relevance rank for each product
    const ranked = products
      .map((p) => {
        const lowerName = (p.name || '').toLowerCase();
        const lowerBrand = (p.brand || '').toLowerCase();
        const lowerCat = (p.category || '').toLowerCase();
        const lowerSku = (p.sku || '').toLowerCase();

        let rank = 100;
        if (lowerName === lowerQ) {
          rank = 1; // Exact name match
        } else if (lowerName.startsWith(lowerQ)) {
          rank = 2; // Name prefix match
        } else if (lowerName.includes(lowerQ)) {
          rank = 3; // Name partial match
        } else if (lowerBrand === lowerQ || lowerBrand.startsWith(lowerQ)) {
          rank = 4; // Brand match
        } else if (lowerCat === lowerQ || lowerCat.startsWith(lowerQ)) {
          rank = 5; // Category match
        } else if (lowerSku.includes(lowerQ)) {
          rank = 6; // SKU match
        } else {
          rank = 7; // Description or keyword match
        }

        return {
          product: p,
          rank,
        };
      })
      .sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank;
        return (b.product.reviewCount || 0) - (a.product.reviewCount || 0);
      })
      .slice(0, 8);

    const formatted = ranked.map(({ product: p }) => ({
      _id: p._id,
      name: p.name,
      slug: p.slug,
      price: p.salePrice,
      originalPrice: p.basePrice > p.salePrice ? p.basePrice : undefined,
      image: p.images?.[0] || '',
      category: p.category,
      brand: p.brand,
      stock: p.stock ?? 0,
      inStock: (p.stock ?? 0) > 0,
      rating: p.rating,
      badge: p.badge,
    }));

    res.json({ success: true, suggestions: formatted });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/products/trending
productsRouter.get('/trending', async (req: Request, res: Response) => {
  try {
    const topSelling = await ProductModel.find({ status: 'active' })
      .sort({ isTopSelling: -1, reviewCount: -1 })
      .limit(12)
      .lean();
    const newArrivals = await ProductModel.find({ status: 'active' })
      .sort({ isNewArrival: -1, createdAt: -1 })
      .limit(12)
      .lean();
    const bestRated = await ProductModel.find({ status: 'active' })
      .sort({ isBestRated: -1, rating: -1 })
      .limit(12)
      .lean();

    res.json({
      success: true,
      data: {
        topSelling,
        newArrivals,
        bestRated,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

const STAFF_PRODUCT_ROLES = new Set([
  'super_admin',
  'admin',
  'catalog_manager',
  'inventory_manager',
  'order_manager',
  'customer_support',
  'finance',
]);

// GET /api/products (filter, search, sort, pagination)
productsRouter.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 12));
    const skip = (page - 1) * limit;

    const isStaff = !!(req.user && STAFF_PRODUCT_ROLES.has(req.user.role));
    const requestedStatus = String(req.query.status || '').toLowerCase().trim();
    const query: any = {};

    if (isStaff && requestedStatus === 'all') {
      // Return all product statuses for admin catalog
    } else if (isStaff && ['active', 'draft', 'archived'].includes(requestedStatus)) {
      query.status = requestedStatus;
    } else {
      query.status = 'active';
    }

    // Category filter
    if (req.query.category && req.query.category !== 'all') {
      query.category = new RegExp(`^${escapeRegex(String(req.query.category))}$`, 'i');
    }

    // Brand filter
    if (req.query.brand) {
      query.brand = new RegExp(`^${escapeRegex(String(req.query.brand))}$`, 'i');
    }

    // Price range filter
    const minPriceNum = req.query.minPrice !== undefined ? Number(req.query.minPrice) : NaN;
    const maxPriceNum = req.query.maxPrice !== undefined ? Number(req.query.maxPrice) : NaN;
    if (Number.isFinite(minPriceNum) || Number.isFinite(maxPriceNum)) {
      query.salePrice = {};
      if (Number.isFinite(minPriceNum)) query.salePrice.$gte = minPriceNum;
      if (Number.isFinite(maxPriceNum)) query.salePrice.$lte = maxPriceNum;
    }

    // Rating filter
    const minRatingNum = req.query.minRating !== undefined ? Number(req.query.minRating) : NaN;
    if (Number.isFinite(minRatingNum)) {
      query.rating = { $gte: minRatingNum };
    }

    // Search query with cross-lingual Bangla/English support
    const search = ((req.query.q as string) || '').trim();
    if (search) {
      const safeRegex = new RegExp(escapeRegex(search), 'i');
      query.$or = [
        { name: safeRegex },
        { brand: safeRegex },
        { category: safeRegex },
        { description: safeRegex },
        { sku: safeRegex },
        { banglaKeywords: { $in: [safeRegex] } },
      ];
    }

    // Sorting
    const sortParam = String(req.query.sort || 'newest');
    let products: any[] = [];
    let total = 0;

    if (sortParam === 'discount') {
      const [aggProducts, totalCount] = await Promise.all([
        ProductModel.aggregate([
          { $match: query },
          {
            $addFields: {
              _discountRatio: {
                $cond: [
                  { $and: [{ $gt: ['$basePrice', 0] }, { $gt: ['$basePrice', '$salePrice'] }] },
                  { $divide: [{ $subtract: ['$basePrice', '$salePrice'] }, '$basePrice'] },
                  0,
                ],
              },
            },
          },
          { $sort: { _discountRatio: -1, createdAt: -1 } },
          { $skip: skip },
          { $limit: limit },
          { $project: { _discountRatio: 0 } },
        ]),
        ProductModel.countDocuments(query),
      ]);
      products = aggProducts;
      total = totalCount;
    } else {
      let sortOptions: any = { createdAt: -1 };
      switch (sortParam) {
        case 'price_asc':
          sortOptions = { salePrice: 1 };
          break;
        case 'price_desc':
          sortOptions = { salePrice: -1 };
          break;
        case 'rating':
          sortOptions = { rating: -1, reviewCount: -1 };
          break;
        case 'popular':
          sortOptions = { reviewCount: -1, rating: -1 };
          break;
        case 'newest':
        default:
          sortOptions = { createdAt: -1 };
          break;
      }

      [products, total] = await Promise.all([
        ProductModel.find(query).sort(sortOptions).skip(skip).limit(limit).lean(),
        ProductModel.countDocuments(query),
      ]);
    }

    // Available brands list for filters
    const availableBrands = await ProductModel.distinct('brand', { status: 'active' });

    res.json({
      success: true,
      products,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      availableBrands,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/products/:slugOrId
productsRouter.get('/:slugOrId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { slugOrId } = req.params;
    const targetSlug = slugOrId.toLowerCase();
    const isStaff = !!(req.user && STAFF_PRODUCT_ROLES.has(req.user.role));

    let product = await ProductModel.findOne({ slug: targetSlug }).lean();
    if (!product && (targetSlug === 'samsung-galaxy-s25' || targetSlug === 'samsung-galaxy-s25-ultra')) {
      product = await ProductModel.findOne({
        slug: { $in: ['samsung-galaxy-s25-ultra', 'samsung-galaxy-s25'] },
      }).lean();
    }
    if (!product && mongoose.Types.ObjectId.isValid(slugOrId)) {
      product = await ProductModel.findById(slugOrId).lean();
    }

    if (!product || (product.status !== 'active' && !isStaff)) {
      return res.status(404).json({ success: false, message: 'Product not found.' });
    }

    // Also fetch related products in the same category, or fallback to trending active products
    let related = await ProductModel.find({
      category: product.category,
      _id: { $ne: product._id },
      status: 'active',
    })
      .limit(4)
      .lean();

    if (related.length < 4) {
      const additional = await ProductModel.find({
        _id: { $nin: [product._id, ...related.map((r) => r._id)] },
        status: 'active',
      })
        .limit(4 - related.length)
        .lean();
      related = [...related, ...additional];
    }

    res.json({ success: true, product, related });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/products (Admin create)
productsRouter.post(
  '/',
  requireRole('super_admin', 'admin', 'catalog_manager'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const parsed = productInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, errors: parsed.error.format() });
      }

      const product = await ProductModel.create(parsed.data);

      await logAuditActivity({
        action: 'CREATE_PRODUCT',
        module: 'Products',
        actorName: req.user!.name,
        actorEmail: req.user!.email,
        actorRole: req.user!.role,
        details: `Created new catalog product "${product.name}" (SKU: ${product.sku}, Price: ৳${product.salePrice})`,
        recordId: product._id.toString(),
        ipAddress: req.ip || '127.0.0.1',
      });

      res.status(201).json({ success: true, message: 'Product created successfully', product });
    } catch (err: any) {
      if (err?.code === 11000) {
        return res.status(409).json({ success: false, message: 'A product with this slug or SKU already exists.' });
      }
      res.status(400).json({ success: false, message: err.message });
    }
  }
);

// PUT /api/products/:id (Admin update)
productsRouter.put(
  '/:id',
  requireRole('super_admin', 'admin', 'catalog_manager', 'inventory_manager'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const parsed = productInputSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ success: false, errors: parsed.error.format() });
      }

      const query = mongoose.Types.ObjectId.isValid(req.params.id)
        ? { _id: req.params.id }
        : { slug: req.params.id.toLowerCase() };

      const product = await ProductModel.findOneAndUpdate(query, parsed.data, { new: true, runValidators: true });
      if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

      await logAuditActivity({
        action: 'UPDATE_PRODUCT',
        module: 'Products',
        actorName: req.user!.name,
        actorEmail: req.user!.email,
        actorRole: req.user!.role,
        details: `Updated product "${product.name}" (SKU: ${product.sku})`,
        recordId: product._id.toString(),
        ipAddress: req.ip || '127.0.0.1',
      });

      res.json({ success: true, message: 'Product updated successfully', product });
    } catch (err: any) {
      if (err?.code === 11000) {
        return res.status(409).json({ success: false, message: 'A product with this slug or SKU already exists.' });
      }
      res.status(400).json({ success: false, message: err.message });
    }
  }
);

// POST /api/products/:id/duplicate (Admin duplicate product)
productsRouter.post(
  '/:id/duplicate',
  requireRole('super_admin', 'admin', 'catalog_manager'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const query = mongoose.Types.ObjectId.isValid(req.params.id)
        ? { _id: req.params.id }
        : { slug: req.params.id.toLowerCase() };

      const original = await ProductModel.findOne(query).lean();
      if (!original) return res.status(404).json({ success: false, message: 'Original product not found' });

      const rand = Math.floor(100 + Math.random() * 900);
      const duplicateData: any = {
        ...original,
        _id: new mongoose.Types.ObjectId(),
        name: `${original.name} (Copy)`,
        slug: `${original.slug}-copy-${rand}`,
        sku: `${original.sku}-CPY${rand}`,
        status: 'draft',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      delete duplicateData.__v;

      const duplicateProduct = await ProductModel.create(duplicateData);

      await logAuditActivity({
        action: 'DUPLICATE_PRODUCT',
        module: 'Products',
        actorName: req.user!.name,
        actorEmail: req.user!.email,
        actorRole: req.user!.role,
        details: `Duplicated product "${original.name}" into "${duplicateProduct.name}" (SKU: ${duplicateProduct.sku})`,
        recordId: duplicateProduct._id.toString(),
        ipAddress: req.ip || '127.0.0.1',
      });

      res.status(201).json({ success: true, message: 'Product duplicated successfully', product: duplicateProduct });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

// DELETE /api/products/:id (Admin delete/archive)
productsRouter.delete(
  '/:id',
  requireRole('super_admin', 'admin'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const query = mongoose.Types.ObjectId.isValid(req.params.id)
        ? { _id: req.params.id }
        : { slug: req.params.id.toLowerCase() };

      const product = await ProductModel.findOneAndDelete(query);
      if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

      await logAuditActivity({
        action: 'DELETE_PRODUCT',
        module: 'Products',
        actorName: req.user!.name,
        actorEmail: req.user!.email,
        actorRole: req.user!.role,
        details: `Deleted product "${product.name}" (SKU: ${product.sku})`,
        recordId: product._id.toString(),
        ipAddress: req.ip || '127.0.0.1',
      });

      res.json({ success: true, message: 'Product deleted successfully' });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

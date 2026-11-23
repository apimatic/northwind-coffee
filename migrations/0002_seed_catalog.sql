-- Reference catalog for Northwind Coffee. Prices are integer cents (USD).
INSERT INTO catalog_brands (id, brand) VALUES
  (1, 'Northwind Roasters'),
  (2, 'Contoso Coffee Co.'),
  (3, 'Fabrikam Farms'),
  (4, 'Tailspin Trading');

INSERT INTO catalog_types (id, type) VALUES
  (1, 'Whole bean'),
  (2, 'Ground'),
  (3, 'Capsules'),
  (4, 'Brewing gear');

INSERT INTO catalog_items (id, name, description, price_cents, picture_uri, catalog_type_id, catalog_brand_id) VALUES
  (1, 'House Blend Whole Bean, 12 oz', 'Our everyday medium roast: milk chocolate, toasted almond and a clean finish.', 1600, '/images/products/house-blend-whole-bean.svg', 1, 1),
  (2, 'Espresso Forte Whole Bean, 1 lb', 'A dark, syrupy espresso blend with notes of cocoa and molasses.', 1950, '/images/products/espresso-forte-whole-bean.svg', 1, 2),
  (3, 'Ethiopia Yirgacheffe Whole Bean, 12 oz', 'Washed single origin with bright citrus, jasmine and bergamot.', 2100, '/images/products/ethiopia-yirgacheffe-whole-bean.svg', 1, 3),
  (4, 'Sumatra Mandheling Whole Bean, 12 oz', 'Full body and low acidity, with cedar, dark chocolate and spice.', 1825, '/images/products/sumatra-mandheling-whole-bean.svg', 1, 4),
  (5, 'Breakfast Blend Ground, 12 oz', 'A light, lively roast ground for drip brewers.', 1450, '/images/products/breakfast-blend-ground.svg', 2, 1),
  (6, 'Swiss Water Decaf Ground, 12 oz', 'Chemical-free decaf with caramel sweetness, ground for drip.', 1575, '/images/products/swiss-water-decaf-ground.svg', 2, 2),
  (7, 'Colombia Huila Ground, 12 oz', 'Red apple, panela and a round body, ground medium.', 1700, '/images/products/colombia-huila-ground.svg', 2, 3),
  (8, 'French Roast Ground, 12 oz', 'Bold and smoky dark roast, ground for drip and pour-over.', 1395, '/images/products/french-roast-ground.svg', 2, 4),
  (9, 'Lungo Capsules, 10 pack', 'Long-shot capsules with a mellow, nutty cup.', 750, '/images/products/lungo-capsules.svg', 3, 1),
  (10, 'Ristretto Capsules, 10 pack', 'Short, intense capsules for a concentrated espresso.', 795, '/images/products/ristretto-capsules.svg', 3, 2),
  (11, 'Organic Capsules, 20 pack', 'Certified organic medium roast in compostable capsules.', 1300, '/images/products/organic-capsules.svg', 3, 3),
  (12, 'Vanilla Capsules, 10 pack', 'Medium roast with a natural vanilla aroma.', 695, '/images/products/vanilla-capsules.svg', 3, 4),
  (13, 'Ceramic Pour-Over Dripper', 'A single-cup ceramic dripper for clean, even extraction.', 2400, '/images/products/ceramic-pour-over-dripper.svg', 4, 1),
  (14, 'French Press, 34 oz', 'Borosilicate glass and a stainless steel plunger. Serves four.', 3900, '/images/products/french-press.svg', 4, 2),
  (15, 'Conical Burr Grinder', 'Forty grind settings, from espresso fine to cold-brew coarse.', 8900, '/images/products/conical-burr-grinder.svg', 4, 3),
  (16, 'Gooseneck Kettle, 1 L', 'Precise pour control for pour-over brewing.', 5400, '/images/products/gooseneck-kettle.svg', 4, 4);

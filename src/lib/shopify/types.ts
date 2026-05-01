export type ShopInfo = {
  id: string;
  name: string;
  email: string;
  myshopifyDomain: string;
  plan: { displayName: string };
};

export type ShopQueryResult = {
  shop: ShopInfo;
};

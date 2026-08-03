/**
 * 分类配置。kindid/search_type 来自实测抓取到的首页分类入口链接：
 *   英雄皮肤: /cgi/mweb/category/list?kindid=3&search_type=role_skin
 *   兵器皮肤: /cgi/mweb/category/list?kindid=4&search_type=weapon_skin
 */
export const CATEGORIES = [
  { key: 'hero_skin', label: '英雄皮肤', kindid: 3, searchType: 'role_skin' },
  { key: 'weapon_skin', label: '兵器皮肤', kindid: 4, searchType: 'weapon_skin' },
];

export function categoryListUrl(category) {
  return `https://yjwujian.cbg.163.com/cgi/mweb/category/list?kindid=${category.kindid}&search_type=${category.searchType}`;
}

export function equipTypeDetailUrl(category, equipType) {
  return `https://yjwujian.cbg.163.com/cgi/mweb/category/detail?search_type=${category.searchType}&equip_type=${equipType}&view_loc=equip_type_detail`;
}

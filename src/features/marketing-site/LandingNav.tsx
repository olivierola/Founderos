/* The marketing nav is the Hunar bar now (see hn/HnNav). This file keeps the
   old address so every page that imports `LandingNav` gets it without
   changing, and `NAV_H` keeps meaning "where a hero has to start". */
export { HnNav as LandingNav, HN_NAV_H as NAV_H } from "./hn/HnNav";

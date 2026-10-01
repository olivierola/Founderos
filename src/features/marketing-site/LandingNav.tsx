/* The marketing nav is the Atlas bar now (see atlas/AtlasNav). This file keeps
   the old address so every page that imports `LandingNav` gets it without
   changing, and `NAV_H` keeps meaning "where a hero has to start". */
export { AtlasNav as LandingNav, ATLAS_NAV_H as NAV_H } from "./atlas/AtlasNav";

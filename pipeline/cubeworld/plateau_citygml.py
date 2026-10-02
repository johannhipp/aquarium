"""Minimal PLATEAU CityGML readers for the cubeworld lab (lxml streaming, no GIS stack).

PLATEAU CityGML 2.0 files are EPSG:6697 (JGD2011 geographic 3D) with posList order
**lat lon height** (height = orthometric, metres above Tokyo Peil). Everything here returns
projected EPSG:6677 (JGD2011 / Japan Plane Rectangular CS IX) coordinates, x = easting,
y = northing (GIS order, NOT the survey convention), z = height.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Iterator

import numpy as np
from lxml import etree
from pyproj import Transformer

NS = {
    "bldg": "http://www.opengis.net/citygml/building/2.0",
    "tran": "http://www.opengis.net/citygml/transportation/2.0",
    "frn": "http://www.opengis.net/citygml/cityfurniture/2.0",
    "veg": "http://www.opengis.net/citygml/vegetation/2.0",
    "brid": "http://www.opengis.net/citygml/bridge/2.0",
    "dem": "http://www.opengis.net/citygml/relief/2.0",
    "gml": "http://www.opengis.net/gml",
    "core": "http://www.opengis.net/citygml/2.0",
}
Q = {k: "{%s}" % v for k, v in NS.items()}

_to6677 = Transformer.from_crs(6697, 6677, always_xy=True)


def project(latlonh: np.ndarray) -> np.ndarray:
    """(n,3) [lat, lon, h] in EPSG:6697 -> (n,3) [E, N, h] in EPSG:6677."""
    x, y = _to6677.transform(latlonh[:, 1], latlonh[:, 0])
    return np.column_stack([x, y, latlonh[:, 2]])


def _ring(pos_list: etree._Element) -> np.ndarray:
    a = np.array(pos_list.text.split(), dtype=np.float64).reshape(-1, 3)
    return project(a)


def polygons(el: etree._Element) -> list[tuple[np.ndarray, list[np.ndarray]]]:
    """All gml:Polygon below el as (exterior ring, [interior rings]) in EPSG:6677 (closing point kept)."""
    out = []
    for poly in el.iter(Q["gml"] + "Polygon"):
        ext = poly.find("gml:exterior//gml:posList", NS)
        if ext is None:
            continue
        holes = [_ring(p) for p in poly.iterfind("gml:interior//gml:posList", NS)]
        out.append((_ring(ext), holes))
    return out


def _code(el: etree._Element, path: str) -> str | None:
    c = el.find(path, NS)
    return None if c is None else (c.text or "").strip()


@dataclass
class Feature:
    kind: str                      # e.g. "Building", "TrafficArea", "AuxiliaryTrafficArea", "Road"
    function: str | None
    lods: dict[str, list[tuple[np.ndarray, list[np.ndarray]]]] = field(default_factory=dict)
    # lods key e.g. "lod1Solid", "lod2MultiSurface", "lod2Solid", "lod3MultiSurface"; for buildings,
    # boundary-surface type (Roof/Wall/Ground/...) is encoded in key suffix: "lod2MultiSurface:RoofSurface"


def _lod_geoms(el: etree._Element) -> dict[str, list[tuple[np.ndarray, list[np.ndarray]]]]:
    out = {}
    for child in el:
        name = etree.QName(child).localname
        if name.startswith("lod") and name.endswith(("MultiSurface", "Solid")):
            polys = polygons(child)  # empty when the geometry is only xlink references
            if polys:
                out[name] = polys
    return out


def iter_tran(path: str) -> Iterator[Feature]:
    """Per Road: its TrafficArea / AuxiliaryTrafficArea children (LOD2/LOD3) when they carry geometry,
    else the Road's own LOD1 polygon. (Road-level LOD2/3 geometry is only xlink references to the children.)"""
    for _, road in etree.iterparse(path, tag=Q["tran"] + "Road", huge_tree=True):
        areas = []
        for el in road.iter(Q["tran"] + "TrafficArea", Q["tran"] + "AuxiliaryTrafficArea"):
            g = _lod_geoms(el)
            if g:
                areas.append(Feature(etree.QName(el).localname, _code(el, "tran:function"), g))
        if areas:
            yield from areas
        else:
            g = _lod_geoms(road)
            if g:
                yield Feature("Road", _code(road, "tran:function"), g)
        road.clear()


def iter_bldg(path: str) -> Iterator[Feature]:
    """Buildings; geometry grouped by lod and boundary-surface type."""
    for _, b in etree.iterparse(path, tag=Q["bldg"] + "Building", huge_tree=True):
        f = Feature("Building", _code(b, "bldg:usage"))
        for child in b:
            name = etree.QName(child).localname
            if name.startswith("lod") and name.endswith(("Solid", "MultiSurface")):
                f.lods.setdefault(name + ":any", []).extend(polygons(child))
        for part in b.iter(Q["bldg"] + "boundedBy"):
            surf = next(iter(part), None)
            if surf is None:
                continue
            stype = etree.QName(surf).localname  # RoofSurface, WallSurface, GroundSurface, ...
            for lod in ("lod2MultiSurface", "lod3MultiSurface"):
                g = surf.find("bldg:" + lod, NS)
                if g is not None:
                    f.lods.setdefault("%s:%s" % (lod, stype), []).extend(polygons(g))
        yield f
        b.clear()


def iter_deep(path: str, tag: str) -> Iterator[Feature]:
    """Any city object (frn:CityFurniture, veg:*, brid:Bridge ...): every lodN geometry anywhere below it,
    grouped as lods["lodN"] (implicit representations are ignored)."""
    for _, el in etree.iterparse(path, tag=tag, huge_tree=True):
        f = Feature(etree.QName(el).localname, None)
        for fn in el.iterfind("*"):
            if etree.QName(fn).localname == "function":
                f.function = (fn.text or "").strip()
                break
        for g in el.iter():
            name = etree.QName(g).localname if isinstance(g.tag, str) else ""
            if name.startswith("lod") and name[3:4].isdigit() and name.endswith(("MultiSurface", "Solid", "Geometry")):
                polys = polygons(g)
                if polys:
                    f.lods.setdefault(name[:4], []).extend(polys)
        if f.lods:
            yield f
        el.clear()


def load_dem_triangles(gml: str, mesh_names: set[str], cache_npz: str) -> dict[str, np.ndarray]:
    """TIN relief triangles (n,3,3) in EPSG:6677 per 3rd-mesh name; cached because the 2nd-mesh file is ~480 MB."""
    if os.path.exists(cache_npz):
        z = np.load(cache_npz)
        return {k: z[k] for k in z.files}
    out: dict[str, np.ndarray] = {}
    for _, el in etree.iterparse(gml, tag=Q["dem"] + "TINRelief", huge_tree=True):
        name = el.find("gml:name", NS).text
        if name in mesh_names:
            tris = np.array(
                [np.array(p.text.split(), dtype=np.float64).reshape(-1, 3)[:3] for p in el.iterfind(".//gml:posList", NS)]
            )
            flat = project(tris.reshape(-1, 3)).reshape(-1, 3, 3)
            out[name] = flat
        el.clear()
    np.savez_compressed(cache_npz, **out)
    return out

#!/usr/bin/env bash
# Cut a copy of Postgres.app's Contents/Versions/<major> down to what Stuga runs.
#
#   packaging/macos/build/prune.sh <tree>
#
# Re-runnable: a path already gone is not an error. check-tree.sh proves the result.
#
# What goes:
#   PostGIS (with pgRouting, which requires it), GDAL, PROJ, GEOS, pljs, and plpython
#   (it links /Library/Frameworks/Python.framework, absent on a clean Mac), plus the
#   libraries only those load and their headers, docs and man pages.
#   ICU's io/tu/test libraries: nothing loads them, and they load siblings by bare name,
#   which dyld resolves against the current directory.
#   libpq-oauth: libpq dlopen()s it by an absolute /Applications/Postgres.app path, so the
#   copy in the tree is never used.
#   Headers, static archives and PGXS: nothing is compiled against this tree, and a
#   static archive cannot carry a code signature.
#
# What stays although it looks unused: libxslt/libexslt (pgxml links them), ecpg,
# pldbgapi and wal2json. Removing a library by guessing is how a server stops starting.
set -euo pipefail

tree="${1:-}"
[ -n "$tree" ] || { echo "usage: $0 <tree>" >&2; exit 2; }
[ -x "$tree/bin/postgres" ] || { echo "error: $tree/bin/postgres not found; not a Postgres.app version tree" >&2; exit 1; }
case "$tree" in
  /Volumes/* | */Postgres.app/Contents/Versions/*)
    echo "error: $tree looks like the Postgres.app bundle itself; prune a copy" >&2; exit 1 ;;
esac
cd "$tree"

# Globs relative to the tree, expanded unquoted on purpose.
PRUNE='
bin/gdal-config bin/gdal_* bin/gdaladdo bin/gdalbuildvrt bin/gdaldem bin/gdalenhance
bin/gdalinfo bin/gdallocationinfo bin/gdalmanage bin/gdalmdiminfo bin/gdalmdimtranslate
bin/gdalsrsinfo bin/gdaltindex bin/gdaltransform bin/gdalwarp
bin/ogr2ogr bin/ogrinfo bin/ogrlineref bin/ogrtindex bin/nearblack bin/sozip
bin/cct bin/cs2cs bin/geod bin/invgeod bin/invproj bin/proj bin/projinfo bin/projsync
bin/geosop
bin/postgis bin/postgis_restore bin/pgsql2shp bin/shp2pgsql bin/raster2pgsql
bin/pgtopo_export bin/pgtopo_import

lib/gdalplugins
lib/libgdal.* lib/libproj.* lib/libgeos.* lib/libgeos_c.*
lib/libSFCGAL.* lib/libboost_*
lib/libgmp.* lib/libgmpxx.* lib/libmpfr.*
lib/libjson-c.* lib/libprotobuf-c.*
lib/libnetcdf.* lib/libopenjp2.* lib/libpng.* lib/libpng16.*
lib/libtiff.* lib/libtiffxx.* lib/libjpeg.*
lib/libicuio.* lib/libicutu.* lib/libicutest.*
lib/libpq-oauth-*.dylib lib/libpq-oauth.a

lib/postgresql/postgis-3.dylib lib/postgresql/postgis_raster-3.dylib
lib/postgresql/postgis_sfcgal-3.dylib lib/postgresql/postgis_topology-3.dylib
lib/postgresql/address_standardizer-3.dylib
lib/postgresql/libpgrouting-*.dylib
lib/postgresql/pljs.dylib
lib/postgresql/plpython3.dylib lib/postgresql/hstore_plpython3.dylib
lib/postgresql/jsonb_plpython3.dylib lib/postgresql/ltree_plpython3.dylib

share/postgresql/contrib/postgis-*
share/postgresql/extension/postgis*
share/postgresql/extension/address_standardizer*
share/postgresql/extension/pgrouting*
share/postgresql/extension/pljs*
share/postgresql/extension/plpython3u*
share/postgresql/extension/hstore_plpython3u* share/postgresql/extension/jsonb_plpython3u*
share/postgresql/extension/ltree_plpython3u*

share/gdal share/proj share/bash-completion share/info
share/doc/postgis share/doc/proj share/doc/mpfr
share/man/man1/cct.1 share/man/man1/cs2cs.1 share/man/man1/geod.1 share/man/man1/gie.1
share/man/man1/proj.1 share/man/man1/projinfo.1 share/man/man1/projsync.1
share/man/man1/gdal* share/man/man1/ogr* share/man/man1/gnm* share/man/man1/nearblack.1
share/man/man1/pct2rgb.1 share/man/man1/rgb2pct.1 share/man/man1/sozip.1
share/man/man1/postgis.1 share/man/man1/postgis_restore.1 share/man/man1/pgsql2shp.1
share/man/man1/shp2pgsql.1 share/man/man1/pgtopo_export.1 share/man/man1/pgtopo_import.1
share/man/man1/cjpeg.1 share/man/man1/djpeg.1 share/man/man1/jpegtran.1
share/man/man1/rdjpgcom.1 share/man/man1/wrjpgcom.1
share/man/man5/png.5
share/man/man1/derb.1 share/man/man1/genbrk.1 share/man/man1/gencfu.1 share/man/man1/gencnval.1
share/man/man1/gendict.1 share/man/man1/genrb.1 share/man/man1/icu-config.1
share/man/man1/icuexportdata.1 share/man/man1/makeconv.1 share/man/man1/pkgdata.1
share/man/man1/uconv.1

include lib/*.a lib/postgresql/pgxs
'

removed=0
for pattern in $PRUNE; do
  for path in $pattern; do
    # An unmatched glob comes back as itself; -L catches a dangling symlink.
    if [ -e "$path" ] || [ -L "$path" ]; then
      rm -rf "$path"
      removed=$((removed + 1))
    fi
  done
done

echo "pruned $removed paths from $tree"

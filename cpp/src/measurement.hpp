// Part of the Chili3d Project, under the LGPL-3.0 License.
// See LICENSE-chili-wasm.txt file in the project root for full license
// information.

#pragma once

#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <BRepExtrema_ExtCC.hxx>
#include <BRepExtrema_ExtCF.hxx>
#include <BRepExtrema_ExtFF.hxx>
#include <BRepExtrema_ExtPC.hxx>
#include <BRepExtrema_ExtPF.hxx>
#include <NCollection_IndexedMap.hxx>
#include <TopExp.hxx>
#include <TopTools_ShapeMapHasher.hxx>
#include <TopoDS.hxx>
#include <cmath>
#include <emscripten/val.h>
#include <vector>

namespace Measurement {
using ShapeMap = NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher>;
// Return witness points as well as the value: the viewport must draw the
// distance the kernel measured, not a line between unrelated bounding-box
// centers.
inline emscripten::val distance(const TopoDS_Shape& a, const TopoDS_Shape& b,
    bool maximum)
{
    using emscripten::val;
    double squared = -1;
    gp_Pnt first, second;
    auto consider = [&](const gp_Pnt& p, const gp_Pnt& q) {
        const double d = p.SquareDistance(q);
        if (std::isfinite(d) && d > squared) {
            squared = d;
            first = p;
            second = q;
        }
    };
    try {
        if (!maximum) {
            BRepExtrema_DistShapeShape extrema(a, b);
            if (!extrema.IsDone() || extrema.NbSolution() == 0)
                return val::null();
            first = extrema.PointOnShape1(1);
            second = extrema.PointOnShape2(1);
            squared = extrema.Value() * extrema.Value();
        } else {
            // A maximum on compact trimmed geometry is stationary in the interiors
            // or on a boundary. Check every face/edge/vertex pairing, including the
            // boundary pairs that an untrimmed surface extremum alone would miss.
            ShapeMap av, ae, af, bv, be, bf;
            TopExp::MapShapes(a, TopAbs_VERTEX, av);
            TopExp::MapShapes(a, TopAbs_EDGE, ae);
            TopExp::MapShapes(a, TopAbs_FACE, af);
            TopExp::MapShapes(b, TopAbs_VERTEX, bv);
            TopExp::MapShapes(b, TopAbs_EDGE, be);
            TopExp::MapShapes(b, TopAbs_FACE, bf);
            auto points = [](const ShapeMap& vertices, const ShapeMap& edges) {
                std::vector<TopoDS_Vertex> result;
                for (int i = 1; i <= vertices.Extent(); ++i)
                    result.push_back(TopoDS::Vertex(vertices(i)));
                // Closed/periodic edges can have a family of stationary solutions.
                // Point-curve extrema at these exact edge points cover that family.
                for (int i = 1; i <= edges.Extent(); ++i) {
                    auto edge = TopoDS::Edge(edges(i));
                    if (!BRep_Tool::IsGeometric(edge) || BRep_Tool::Degenerated(edge))
                        continue;
                    BRepAdaptor_Curve curve(edge);
                    const double u = (curve.FirstParameter() + curve.LastParameter()) * 0.5;
                    if (std::isfinite(u))
                        result.push_back(BRepBuilderAPI_MakeVertex(curve.Value(u)));
                }
                return result;
            };
            const auto ap = points(av, ae), bp = points(bv, be);
            for (const auto& p : ap)
                for (const auto& q : bp)
                    consider(BRep_Tool::Pnt(p), BRep_Tool::Pnt(q));
            auto pointPairs = [&](const auto& vertices, const auto& edges,
                                  const auto& faces, bool swap) {
                auto add = [&](const gp_Pnt& p, const gp_Pnt& q) {
                    if (swap)
                        consider(q, p);
                    else
                        consider(p, q);
                };
                for (const auto& vertex : vertices) {
                    const auto p = BRep_Tool::Pnt(vertex);
                    for (int j = 1; j <= edges.Extent(); ++j) {
                        const auto edge = TopoDS::Edge(edges(j));
                        if (!BRep_Tool::IsGeometric(edge) || BRep_Tool::Degenerated(edge))
                            continue;
                        BRepExtrema_ExtPC ex(vertex, edge);
                        if (ex.IsDone())
                            for (int k = 1; k <= ex.NbExt(); ++k)
                                add(p, ex.Point(k));
                    }
                    for (int j = 1; j <= faces.Extent(); ++j) {
                        BRepExtrema_ExtPF ex(vertex, TopoDS::Face(faces(j)),
                            Extrema_ExtFlag_MAX);
                        if (ex.IsDone())
                            for (int k = 1; k <= ex.NbExt(); ++k)
                                add(p, ex.Point(k));
                    }
                }
            };
            pointPairs(ap, be, bf, false);
            pointPairs(bp, ae, af, true);
            for (int i = 1; i <= ae.Extent(); ++i) {
                const auto edge = TopoDS::Edge(ae(i));
                if (!BRep_Tool::IsGeometric(edge) || BRep_Tool::Degenerated(edge))
                    continue;
                for (int j = 1; j <= be.Extent(); ++j) {
                    const auto other = TopoDS::Edge(be(j));
                    if (!BRep_Tool::IsGeometric(other) || BRep_Tool::Degenerated(other))
                        continue;
                    BRepExtrema_ExtCC ex(edge, other);
                    if (ex.IsDone() && !ex.IsParallel())
                        for (int k = 1; k <= ex.NbExt(); ++k)
                            consider(ex.PointOnE1(k), ex.PointOnE2(k));
                }
            }
            auto edgeFaces = [&](const auto& edges, const auto& faces, bool swap) {
                for (int i = 1; i <= edges.Extent(); ++i) {
                    const auto edge = TopoDS::Edge(edges(i));
                    if (!BRep_Tool::IsGeometric(edge) || BRep_Tool::Degenerated(edge))
                        continue;
                    for (int j = 1; j <= faces.Extent(); ++j) {
                        BRepExtrema_ExtCF ex(edge, TopoDS::Face(faces(j)));
                        if (ex.IsDone() && !ex.IsParallel())
                            for (int k = 1; k <= ex.NbExt(); ++k) {
                                if (swap)
                                    consider(ex.PointOnFace(k), ex.PointOnEdge(k));
                                else
                                    consider(ex.PointOnEdge(k), ex.PointOnFace(k));
                            }
                    }
                }
            };
            edgeFaces(ae, bf, false);
            edgeFaces(be, af, true);
            for (int i = 1; i <= af.Extent(); ++i)
                for (int j = 1; j <= bf.Extent(); ++j) {
                    BRepExtrema_ExtFF ex(TopoDS::Face(af(i)), TopoDS::Face(bf(j)));
                    if (ex.IsDone() && !ex.IsParallel())
                        for (int k = 1; k <= ex.NbExt(); ++k)
                            consider(ex.PointOnFace1(k), ex.PointOnFace2(k));
                }
        }
        if (squared < 0)
            return val::null();
        auto point = [](const gp_Pnt& p) {
            auto result = val::object();
            result.set("x", p.X());
            result.set("y", p.Y());
            result.set("z", p.Z());
            return result;
        };
        auto result = val::object();
        result.set("value", std::sqrt(squared));
        result.set("first", point(first));
        result.set("second", point(second));
        return result;
    } catch (const Standard_Failure&) {
        return val::null();
    }
}
} // namespace Measurement

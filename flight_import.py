"""
flight_import — deterministic conversion of a normalized flight payload into a
CNS build blob + a structured report. Pure functions (resolution is injected),
so they unit-test without Flask or the airport CSV.

Pipeline (build_blob): validate → resolve codes → classify trip type →
aggregate identical routes into frequencies → assemble the build blob.
"""


def classify_trip(idents):
    """Classify an ordered list of resolved airport idents into a CNS trip.

    route[0]==route[-1] (round trip):
      - exactly one distinct intermediate -> 'retour' (o=start, d=far point)
      - multiple distinct intermediates   -> 'circular' (o=d=start, s=stops)
    otherwise -> 'oneway' (o=first, d=last, s=middles).
    """
    o = idents[0]
    last = idents[-1]
    if o == last:
        seen, mids = set(), []
        for x in idents[1:-1]:
            if x not in seen:
                seen.add(x)
                mids.append(x)
        if len(mids) == 1:
            return {'t': 'retour', 'o': o, 'd': mids[0], 's': []}
        return {'t': 'circular', 'o': o, 'd': o, 's': mids}
    return {'t': 'oneway', 'o': o, 'd': last, 's': list(idents[1:-1])}

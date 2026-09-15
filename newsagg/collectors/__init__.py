"""Source-specific collectors.

Each ``*Collector`` knows how to turn one source into ``RawItem``s (or, for
Ape Wisdom, ``MentionEntry``s). They share the HTTP client and settings but
otherwise know nothing about each other.
"""

from newsagg.collectors.apewisdom import ApeWisdomCollector
from newsagg.collectors.schwab_youtube import SchwabYouTubeCollector
from newsagg.collectors.seekingalpha import SeekingAlphaCollector
from newsagg.collectors.substack import SubstackCollector

__all__ = [
    "SeekingAlphaCollector",
    "SubstackCollector",
    "SchwabYouTubeCollector",
    "ApeWisdomCollector",
]

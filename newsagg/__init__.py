"""Financial news aggregation — bullish-signal seed pipeline.

Step 1 (this package's ``collectors``): pull raw items from
SeekingAlpha, Substack, Schwab's YouTube channel, and Ape Wisdom.
Later steps normalize each item into a bullish seed row via an LLM.
"""

__version__ = "0.1.0"

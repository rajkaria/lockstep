Advanced
========

Deleting
--------

Call :py:meth:`miniclient.graph.Graph.delete` when done. Back to :doc:`quickstart`.

.. testcode::

   from miniclient import Client
   g = Client().select_graph("old")
   g.delete(True)

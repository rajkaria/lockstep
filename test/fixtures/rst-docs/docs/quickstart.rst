.. _quickstart:

==========
Quickstart
==========

.. module:: miniclient

Eager to get started? Install with ``pip install miniclient``.

Connect
-------

Use :class:`~miniclient.Client` and :meth:`Client.select_graph` to open a graph::

    from miniclient import Client
    db = Client(host="localhost")
    g = db.select_graph("social")

Read-only queries
-----------------

.. code-block:: python
   :caption: reads

   result = g.ro_query("MATCH (n) RETURN n")

See :ref:`quickstart` and :doc:`/advanced`.

Doctests
~~~~~~~~

>>> g.query("RETURN 1")
[1]

.. staleproof: skip

.. code-block:: python

   g.query("not run")

Shell::

    $ pip install miniclient

# Sentinel-2 data source

Automatic surface imagery is based on public Copernicus Sentinel-2 Level-2A Collection 1 data. The application reads bounded true-color and scene-classification COG windows, masks invalid/cloud/shadow pixels, and may combine several acquisitions. Satellite data is fetched on demand, not bundled with the application.

Data registry: https://registry.opendata.aws/sentinel-2-l2a-cogs/

Catalog documentation: https://github.com/Element84/earth-search/blob/main/docs/collections/sentinel-2-l2a.md

Legal notice: https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice

Official explanation: https://documentation.dataspace.copernicus.eu/FAQ.html

Derived imagery and color model metadata carry the notice “Contains modified Copernicus Sentinel data [Year]”, using the actual acquisition years. When sharing a derived model, retain this source attribution with the model or its accompanying description.

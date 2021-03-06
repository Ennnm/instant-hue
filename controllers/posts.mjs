// db is an argument to this function so
// that we can make db queries inside
import fs from 'fs';
import util from 'util';

import {
  getIdsAfterSortOrFilter,
  getColorsFromImgId,
  handleError,
  addImgToCategoryObj,
  convertToHueBnds,
  captitalizeFirstLetter,
} from '../util.mjs';
import {
  imgFilePath,
  resizeAndProcessImg,
  processImage,
} from '../color.mjs';
import {
  downloadSmallImg,
} from '../download-from-url.mjs';
import { isDeployedLocally, uploadFile, getSignedUrl } from '../locals.mjs';

const unlinkFile = util.promisify(fs.unlink);

export default function initPostsController(db, pool) {
  const index = async (req, res) => {
    console.log('in index of post controller');
    const limitNum = 100;
    const { sort, filter, order } = req.query;

    const ids = await getIdsAfterSortOrFilter(pool, limitNum, sort, order, filter);

    const poolPromises = [];
    ids.forEach((id) => {
      poolPromises.push(getColorsFromImgId(pool, id, false, isDeployedLocally));
    });

    const posts = await Promise.all(poolPromises).catch(handleError);
    res.render('index', {
      posts, enableDelete: false, url: '', enableExpansion: true, colorValue: res.locals.colorPicker,
    });
  };
  const indexCategories = async (req, res) => {
    const categoryQuery = 'SELECT DISTINCT categories.id, categories.category FROM categories INNER JOIN image_categories ON image_categories.category_id = categories.id INNER JOIN images ON images.id = image_categories.image_id';

    const { rows } = await pool.query(categoryQuery).catch(handleError);

    const categoriesObj = await addImgToCategoryObj(pool, rows).catch(handleError);

    console.log('categoriesObj', categoriesObj);
    res.render('index-categories', {
      categoriesObj, enableDelete: false, enableExpansion: true, colorValue: res.locals.colorPicker,
    });
  };

  const indexByColor = async (req, res) => {
    const { colorPicker } = req.query;
    res.locals.colorPicker = colorPicker;

    console.log('color picker:', colorPicker);
    const range = 30;
    const lowerHueBnd = convertToHueBnds(colorPicker - range);
    const upperHueBnd = convertToHueBnds(Number(colorPicker) + range);

    const colQuery = 'SELECT main_hue, images.id FROM images INNER JOIN base_colors ON images.id = base_colors.image_id WHERE base_colors.main_hue>$1 AND base_colors.main_hue<$2 ORDER BY main_hue ASC';
    const { rows } = await pool.query(colQuery, [lowerHueBnd, upperHueBnd]).catch(handleError);

    const ids = rows.map((row) => row.id);

    const poolPromises = [];
    ids.forEach((id) => {
      poolPromises.push(getColorsFromImgId(pool, id, false, isDeployedLocally));
    });
    const posts = await Promise.all(poolPromises).catch(handleError);
    res.render('index', {
      posts, enableDelete: false, enableExpansion: true, url: '', colorValue: colorPicker,
    });
  };
  const show = async (req, res) => {
    const { id } = req.params;
    const postObj = await getColorsFromImgId(pool, id, true, isDeployedLocally).catch(handleError);

    res.render('post', { ...postObj, imagePath: 'test/' });
  };

  const destroy = (req, res) => {
    const { userId } = req.cookies;
    const { id } = req.params;

    const whenDeleted = (err, result) => {
      if (err)
      {
        console.log('Error when deleting', err.stack);
        res.status(503).send(result);
      }
      else {
        console.log('delete returning result', result.rows[0].path);
        const filePath = isDeployedLocally ? `./uploads/${result.rows[0].path}` : result.rows[0].path;
        fs.unlink(filePath, (e) => console.log(e));
        res.redirect(`/user/${userId}`);
      }
    };

    const sqlQuery = `DELETE FROM images WHERE id = ${id} RETURNING *`;
    pool.query(sqlQuery, whenDeleted);
  };
  const createForm = async (req, res) => {
    const { userId } = req.cookies;
    console.log('in createform handler');
    if (req.isUserLoggedIn === true)
    {
    // categories from drop down list
      const { rows } = await pool.query(`SELECT category FROM categories INNER JOIN image_categories on categories.id = image_categories.category_id INNER JOIN images ON image_categories.image_id = images.id WHERE images.users_id=${userId}`);
      const categories = rows.map((obj) => obj.category);
      res.render('upload', { categories });
    }
    else {
      const obj = {
        title: 'Login',
        action: '/login',
        err: 'Need to be logged-in to analyse pictures.',
      };
      res.render('login', obj);
    }
  };
  const create = async (req, res) => {
    const { userId } = req.cookies;
    let { imgUrl, category } = req.body;
    category = captitalizeFirstLetter(category);
    if (req.file)
    {
      const { filename, location } = req.file;
      console.log('file location', location);
      fs.access('./uploads', (error) => {
        if (error)
        {
          fs.mkdirSync('./uploads');
        }
      });
      const filePath = imgFilePath(filename);
      resizeAndProcessImg(pool, filename, filePath, category, userId, 500).then((imageId) => {
        res.redirect(`/picture/${imageId}`);
      }).catch(handleError);
    }
    else if (imgUrl) {
      const filename = `${Date.now()}.jpg`;
      const filepath = imgFilePath(filename);
      const maxSize = 500;

      await downloadSmallImg(imgUrl, filepath, maxSize)
        .then(() => processImage(pool, filename, category, userId))
        .then((imageId) => {
          res.redirect(`/picture/${imageId}`);
        })
        .catch((e) => {
          console.error(e);
          res.render('upload.ejs', { err: 'Unable to get image from url' });
        });
    }
    else {
      res.render('upload.ejs', { err: 'No image uploaded' });
    }
  // render next page with image and analyze templates
  };

  const createS3 = async (req, res) => {
    const { file } = req;
    console.log(file);

    const { userId } = req.cookies;
    let { imgUrl, category } = req.body;
    category = captitalizeFirstLetter(category);
    // TODO if processImage has error, convey error to page, DELETE from db record
    if (req.file)
    {
      console.log('file in createS3 :>> ', file);
      const result = await uploadFile(file);
      await unlinkFile(file.path);
      console.log('result :>> ', result);
      console.log('in createS3');
      console.log('getSignedUrl(result.key) :>> ', getSignedUrl(result.key));
      const location = getSignedUrl(result.key);

      await processImage(pool, location, category, userId, result.key).then((imageId) => res.redirect(`/picture/${imageId}`)).catch((e) => {
        console.log('error in accepting s3 upload', e);
        res.render('upload-no-img-url.ejs', { err: 'Unable to load this image' });
      });
    }
    if (imgUrl) {
      const filename = `${Date.now()}.jpg`;

      const maxSize = 500;

      const fileObj = {
        path: filename,
        filename,
      };
      console.log('before downloadsmallimg');
      try {
        await downloadSmallImg(imgUrl, filename, maxSize);
        // need to upload image to s3
        console.log('before upload file');
        const result = await uploadFile(fileObj);
        await unlinkFile(fileObj.path);
        console.log('before get signed url');
        const location = getSignedUrl(result.key);

        await processImage(pool, location, category, userId, result.key)
          .then((imageId) => {
            res.redirect(`/picture/${imageId}`);
          })
          .catch((e) => {
            console.error(e);
            res.render('upload.ejs', { err: 'Unable to get image from url' });
          });
      } catch (e) {
        console.error('error in s3 imgurl', e);
        res.render('upload.ejs', { err: 'Unable to get image from url' });
      }
    }
    else {
      res.render('upload-no-img-url.ejs', { err: 'No image uploaded' });
    }
  // render next page with image and analyze templates
  };
  return {
    index,
    indexCategories,
    indexByColor,
    show,
    destroy,
    createForm,
    create,
    createS3,
  };
}
